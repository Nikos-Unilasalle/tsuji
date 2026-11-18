import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { EvalContext } from "../types";
import { VISEMES } from "../../audio/lipsync";
import { MORPH_TARGETS_NODE } from "./lipsync";
import { MAKE_MORPH_TARGETS_NODE } from "./makeMorphTargets";

const ctx = (nodeId: string): EvalContext => ({ time: 0, step: 0, nodeId });
const sphere = () => new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial());

/** A copy of the basis with every vertex pushed by `offset`, as a deformer would leave it. */
function moved(basis: THREE.Mesh, offset: THREE.Vector3): THREE.Mesh {
  const geometry = basis.geometry.clone();
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) + offset.x, pos.getY(i) + offset.y, pos.getZ(i) + offset.z);
  return new THREE.Mesh(geometry, basis.material);
}

describe("MAKE_MORPH_TARGETS_NODE", () => {
  test("stores each target as a named delta from the basis", () => {
    const basis = sphere();
    const out = MAKE_MORPH_TARGETS_NODE.evaluate(
      { basis, target0: moved(basis, new THREE.Vector3(0, 1, 0)), target1: moved(basis, new THREE.Vector3(2, 0, 0)) },
      MAKE_MORPH_TARGETS_NODE.defaultParams,
      ctx("mmt-a"),
    );
    const mesh = out.geometry as THREE.Mesh;
    expect(out.count).toBe(2);
    expect(mesh).not.toBe(basis);
    expect(mesh.geometry).not.toBe(basis.geometry);
    expect(basis.geometry.morphAttributes.position).toBeUndefined();
    expect(mesh.geometry.morphTargetsRelative).toBe(true);
    expect(mesh.morphTargetDictionary).toEqual({ open: 0, wide: 1 });
    expect(mesh.morphTargetInfluences).toEqual([0, 0]);
    const [open, wide] = mesh.geometry.morphAttributes.position!;
    expect([open.getX(3), open.getY(3), open.getZ(3)]).toEqual([0, 1, 0]);
    expect([wide.getX(5), wide.getY(5), wide.getZ(5)]).toEqual([2, 0, 0]);
    expect(mesh.geometry.morphAttributes.normal).toHaveLength(2);
  });

  test("a target moved by a transform is read where it is seen, in the basis's space", () => {
    const basis = sphere();
    basis.scale.setScalar(2);
    const target = moved(basis, new THREE.Vector3());
    target.scale.setScalar(2);
    target.position.set(0, 4, 0);
    const out = MAKE_MORPH_TARGETS_NODE.evaluate({ basis, target0: target }, { names: "up" }, ctx("mmt-b"));
    const delta = (out.geometry as THREE.Mesh).geometry.morphAttributes.position![0];
    expect(delta.getY(0)).toBeCloseTo(2);
  });

  test("a target with a different vertex count is skipped, unnamed targets get a default name", () => {
    const basis = sphere();
    const out = MAKE_MORPH_TARGETS_NODE.evaluate(
      { basis, target0: new THREE.Mesh(new THREE.BoxGeometry()), target1: moved(basis, new THREE.Vector3(1, 0, 0)) },
      { names: "" },
      ctx("mmt-c"),
    );
    expect(out.count).toBe(1);
    expect((out.geometry as THREE.Mesh).morphTargetDictionary).toEqual({ target2: 0 });
  });

  test("rebuilds only when an input changes", () => {
    const basis = sphere();
    const target = moved(basis, new THREE.Vector3(0, 1, 0));
    const first = MAKE_MORPH_TARGETS_NODE.evaluate({ basis, target0: target }, { names: "a" }, ctx("mmt-d")).geometry;
    expect(MAKE_MORPH_TARGETS_NODE.evaluate({ basis, target0: target }, { names: "a" }, ctx("mmt-d")).geometry).toBe(first);
    target.geometry.attributes.position.needsUpdate = true;
    expect(MAKE_MORPH_TARGETS_NODE.evaluate({ basis, target0: target }, { names: "a" }, ctx("mmt-d")).geometry).not.toBe(first);
  });

  test("keeps the group around the mesh, and Morph Targets drives the result by name", () => {
    const basis = sphere();
    const group = new THREE.Group().add(basis);
    const out = MAKE_MORPH_TARGETS_NODE.evaluate(
      { basis: group, target0: moved(basis, new THREE.Vector3(0, 1, 0)) },
      { names: "viseme_aa" },
      ctx("mmt-e"),
    );
    expect(out.geometry).toBeInstanceOf(THREE.Group);
    const weights = VISEMES.map((v) => (v === "viseme_aa" ? 0.7 : 0));
    const driven = MORPH_TARGETS_NODE.evaluate({ geometry: out.geometry, weights }, MORPH_TARGETS_NODE.defaultParams, ctx("mt"));
    expect(driven.matched).toBe(1);
    expect(((out.geometry as THREE.Group).children[0] as THREE.Mesh).morphTargetInfluences).toEqual([0.7]);
  });

  test("no basis, no crash", () => {
    expect(MAKE_MORPH_TARGETS_NODE.evaluate({}, MAKE_MORPH_TARGETS_NODE.defaultParams, ctx("mmt-f")).count).toBe(0);
  });
});

describe("MAKE_MORPH_TARGETS_NODE with an unshared target", () => {
  test("a target split into one vertex per triangle corner still pairs with the basis", () => {
    const basis = sphere();
    const flat = moved(basis, new THREE.Vector3(0, 0, 3));
    flat.geometry = flat.geometry.toNonIndexed();
    const out = MAKE_MORPH_TARGETS_NODE.evaluate({ basis, target0: flat }, { names: "push" }, ctx("mmt-g"));
    expect(out.count).toBe(1);
    const delta = (out.geometry as THREE.Mesh).geometry.morphAttributes.position![0];
    expect(delta.count).toBe(basis.geometry.attributes.position.count);
    for (const i of [0, 7, 30]) expect([delta.getX(i), delta.getY(i), delta.getZ(i)]).toEqual([0, 0, 3]);
  });
});
