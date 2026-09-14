import { describe, expect, it } from "vitest";
import { DEFAULT_GROUP, getGroupName } from "./paramGroups";
import { DEFAULT_REGISTRY } from "../shared/graph/nodes";
import { NodeDefinition, ParamFieldDef } from "../shared/graph/types";

function fieldsOf(def: NodeDefinition): ParamFieldDef[] {
  const fields = [...(def.paramFields ?? [])];
  try {
    const dynamic = def.dynamicParamFields?.({
      id: "probe",
      type: def.type,
      params: { ...def.defaultParams },
      position: { x: 0, y: 0 },
    });
    if (dynamic) fields.push(...dynamic);
  } catch {
    // A builder that needs more than a bare instance contributes nothing here.
  }
  return fields;
}

describe("getGroupName", () => {
  it("honours a group the field names for itself", () => {
    expect(getGroupName({ id: "angle", label: "Angle", kind: "number", group: "Brush" })).toBe("Brush");
  });

  it("infers the sections that exist so object nodes don't repeat themselves", () => {
    expect(getGroupName({ id: "location", label: "Location", kind: "vector" })).toBe("Transform");
    expect(getGroupName({ id: "roughness", label: "Roughness", kind: "number" })).toBe("Material");
    expect(getGroupName({ id: "angle", label: "Angle", kind: "number" })).toBe("Light Settings");
    expect(getGroupName({ id: "coverage", label: "Coverage", kind: "number" })).toBe(DEFAULT_GROUP);
  });
});

/**
 * The inference is a trap for any node that reuses one of those words for
 * something else — "Light Settings" is collapsed by default, so a
 * post-process field called `angle` is invisible until the operator expands a
 * section that has no business being on that node at all. That is exactly how
 * Dry Brush shipped with a Stroke Angle nobody could find.
 *
 * A post-process node has no transform, no material and no lens, so every one
 * of its fields belongs in the flat default section. Anything else is a name
 * collision, and this says so by name rather than leaving it to be noticed on
 * screen.
 */
describe("post-process fields stay out of the sections meant for objects", () => {
  const postNodes = [...DEFAULT_REGISTRY.values()].filter((def) => def.category === "postprocess");

  it("covers the whole post-process catalogue", () => {
    expect(postNodes.length).toBeGreaterThan(15);
  });

  for (const def of postNodes) {
    it(`${def.type}`, () => {
      const misfiled = fieldsOf(def)
        .filter((field) => !field.group)
        .map((field) => ({ id: field.id, group: getGroupName(field) }))
        .filter((entry) => entry.group !== DEFAULT_GROUP);

      expect(misfiled).toEqual([]);
    });
  }
});
