import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { evaluateGraph } from "../evaluate";
import { createRegistry, EvalContext } from "../types";
import { MERGE_NODE } from "./merge";
import { disposeNodeCaches } from "../nodeCaches";
import { OBJECT_BOX_NODE } from "./object";
import { RENDER_NODE } from "./render";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "test" };

describe("MERGE_NODE", () => {
  test("combines connected geometry inputs into one Group", () => {
    const a = new THREE.Object3D();
    const b = new THREE.Object3D();
    const result = MERGE_NODE.evaluate({ in0: a, in1: b }, {}, CTX).geometry as THREE.Group;

    expect(result).toBeInstanceOf(THREE.Group);
    expect(result.children).toEqual([a, b]);
  });

  test("an empty trailing socket (undefined) contributes nothing", () => {
    const a = new THREE.Object3D();
    const result = MERGE_NODE.evaluate({ in0: a, in1: undefined }, {}, CTX).geometry as THREE.Group;

    expect(result.children).toEqual([a]);
  });

  test("re-evaluating drops an input that's no longer connected — the group isn't a one-way accumulator", () => {
    const a = new THREE.Object3D();
    const b = new THREE.Object3D();
    MERGE_NODE.evaluate({ in0: a, in1: b }, {}, CTX);
    const result = MERGE_NODE.evaluate({ in0: a }, {}, CTX).geometry as THREE.Group;

    expect(result.children).toEqual([a]);
  });

  test("dynamicInputs always offers exactly one socket past the last connected one", () => {
    // "visible", "matrix" and the material sockets lead the geometry inputs
    // (see evaluate.ts) — the growing In N sockets follow them.
    expect(MERGE_NODE.dynamicInputs?.([]).map((s) => s.id)).toEqual([
      "visible",
      "matrix",
      "material",
      "texture",
      "normal",
      "uvScale",
      "uvOffset",
      "in0",
    ]);
    expect(
      MERGE_NODE.dynamicInputs?.([
        { id: "c0", fromNode: "box", fromSocket: "geometry", toNode: "merge", toSocket: "in0" },
      ]).map((s) => s.id),
    ).toEqual(["visible", "matrix", "material", "texture", "normal", "uvScale", "uvOffset", "in0", "in1"]);
  });

  test("overrideMaterials applies material params to every descendant mesh", () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x0000ff }));
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
    const result = MERGE_NODE.evaluate(
      { in0: a, in1: b },
      { overrideMaterials: 1, color: new THREE.Color(0xff0000) },
      CTX,
    ).geometry as THREE.Group;

    for (const child of result.children) {
      expect(((child as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
    }
  });

  test("overrideMaterials off leaves child materials untouched", () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x0000ff }));
    MERGE_NODE.evaluate({ in0: a }, { overrideMaterials: 0, color: new THREE.Color(0xff0000) }, CTX);
    expect((a.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x0000ff);
  });

  test("connecting a material socket overrides materials even without the toggle", () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x0000ff }));
    const mat = { color: new THREE.Color(0xff0000), roughness: 0.5, opacity: 1.0 };
    MERGE_NODE.evaluate(
      { in0: a, material: mat },
      { overrideMaterials: 0 },
      { ...CTX, connectedInputs: new Set(["material"]) },
    );
    expect((a.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
  });

  test("connecting a texture socket also triggers the override", () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x0000ff }));
    const texture = new THREE.Texture();
    texture.image = { width: 1, height: 1 };
    MERGE_NODE.evaluate(
      { in0: a, texture },
      { overrideMaterials: 0, color: new THREE.Color(0x00ff00) },
      { ...CTX, connectedInputs: new Set(["texture"]) },
    );
    expect((a.material as THREE.MeshStandardMaterial).map).toBe(texture);
  });

  test("end to end through evaluateGraph: two Box nodes into Merge into Render both survive", () => {
    const registry = createRegistry([OBJECT_BOX_NODE, MERGE_NODE, RENDER_NODE]);
    const graph = {
      nodes: [
        { id: "boxA", type: "object/box", params: {}, position: { x: 0, y: 0 } },
        { id: "boxB", type: "object/box", params: {}, position: { x: 0, y: 0 } },
        { id: "merge", type: "structure/merge", params: {}, position: { x: 0, y: 0 } },
        { id: "output", type: "render", params: {}, position: { x: 0, y: 0 } },
      ],
      connections: [
        { id: "e1", fromNode: "boxA", fromSocket: "geometry", toNode: "merge", toSocket: "in0" },
        { id: "e2", fromNode: "boxB", fromSocket: "geometry", toNode: "merge", toSocket: "in1" },
        { id: "e3", fromNode: "merge", fromSocket: "geometry", toNode: "output", toSocket: "geometry" },
      ],
    };

    const result = evaluateGraph(graph, registry, CTX);
    const group = result.get("output")?.geometry as THREE.Group;

    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children).toHaveLength(2);
  });

  test("an override leaves the children's own materials, and anything sharing them, alone", () => {
    const shared = new THREE.MeshStandardMaterial({ color: 0x336699 });
    const child = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const sibling = new THREE.Mesh(new THREE.BoxGeometry(), shared); // e.g. the other half of a Separate
    const texture = new THREE.Texture({} as any);
    texture.image = { width: 4, height: 4 } as any;
    const ctx = { ...CTX, nodeId: "merge-override", connectedInputs: new Set(["texture"]) };

    const group = MERGE_NODE.evaluate({ in0: child, texture }, { ...MERGE_NODE.defaultParams }, ctx).geometry as THREE.Group;
    const overridden = (group.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(overridden.map).toBe(texture);
    expect(overridden).not.toBe(shared);
    expect(shared.map).toBeNull();
    expect(sibling.material).toBe(shared);

    // Every frame hands back the same override material, not a new one.
    child.material = shared;
    MERGE_NODE.evaluate({ in0: child, texture }, { ...MERGE_NODE.defaultParams }, ctx);
    expect(child.material).toBe(overridden);
  });

  test("deleting the node leaves its children's geometry and materials to their own nodes", () => {
    const material = new THREE.MeshStandardMaterial();
    const geometry = new THREE.BoxGeometry();
    const child = new THREE.Mesh(geometry, material);
    let disposed = 0;
    material.addEventListener("dispose", () => disposed++);
    geometry.addEventListener("dispose", () => disposed++);

    MERGE_NODE.evaluate({ in0: child }, { ...MERGE_NODE.defaultParams }, { ...CTX, nodeId: "merge-delete" });
    disposeNodeCaches(["merge-delete"]);

    expect(disposed).toBe(0);
    expect(child.parent).toBeNull();
  });
});
