import { describe, expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "./nodes/index";
import { NODE_RESET_PARAMS_ACTION, nodeResetPatch, resetActionOf } from "./nodeActions";
import { EDIT_MESH_NODE, EDIT_MESH_RESEED_ACTION } from "./nodes/editMesh";

describe("node Reset", () => {
  const defs = [...DEFAULT_REGISTRY.values()];

  it("only resets params a node actually has", () => {
    const resettable = defs.filter((d) => d.reset && "params" in d.reset);
    expect(resettable.length).toBeGreaterThan(0);
    for (const def of resettable) {
      for (const id of (def.reset as { params: string[] }).params) expect(id in def.defaultParams, `${def.type}.${id}`).toBe(true);
    }
  });

  it("puts the authored data back to the defaults, and nothing else", () => {
    const sculpt = DEFAULT_REGISTRY.get("object/sculpt")!;
    expect(resetActionOf(sculpt)).toBe(NODE_RESET_PARAMS_ACTION);
    expect(nodeResetPatch(sculpt)).toEqual({ sculptMesh: null });
    const curve = DEFAULT_REGISTRY.get("curve/from_points")!;
    const patch = nodeResetPatch(curve)!;
    expect(Object.keys(patch)).toEqual(["pointsList"]);
    // A fresh copy, not the definition's own array.
    expect(patch.pointsList).not.toBe(curve.defaultParams.pointsList);
    expect(patch.pointsList).toEqual(curve.defaultParams.pointsList);
  });

  it("hands Edit Mesh its own reset (re-reading its input), and gives plain nodes none", () => {
    expect(resetActionOf(DEFAULT_REGISTRY.get(EDIT_MESH_NODE.type))).toBe(EDIT_MESH_RESEED_ACTION);
    expect(resetActionOf(DEFAULT_REGISTRY.get("object/box"))).toBeNull();
    expect(nodeResetPatch(DEFAULT_REGISTRY.get("object/box"))).toBeNull();
  });
});
