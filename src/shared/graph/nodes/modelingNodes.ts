import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { isValidAttributeName, readAttribute, setAttribute } from "../mesh/polyAttributes";
import { joinMeshes } from "../mesh/join";
import { applyMaterialParams, materialParamsFromValue } from "./object";
import { definePolyNode } from "./polyModifier";

/*
 * Modelling nodes that sit between the selection and the operations: putting
 * meshes together and giving groups their own look.
 */

// ============================================================ Join

export const JOIN_NODE = definePolyNode({
  type: "modeling/join",
  label: "Join Meshes",
  category: "modeling",
  inputs: [
    { id: "b", label: "Geometry B", type: "geometry" },
    { id: "c", label: "Geometry C", type: "geometry" },
    { id: "d", label: "Geometry D", type: "geometry" },
  ],
  defaultParams: { sourceAttribute: "" },
  paramFields: [{ id: "sourceAttribute", label: "Write input index to face attribute (optional)", kind: "text" }],
  run: (run) => {
    // Each other input comes in already placed where it is on screen,
    // relative to the first one (otherMesh brings it into this mesh's space).
    const others = ["b", "c", "d"].map((id) => run.otherMesh(id)).filter((m): m is NonNullable<typeof m> => Boolean(m));
    const name = run.str("sourceAttribute", "").trim();
    if (name && !isValidAttributeName(name)) run.note(`"${name}" is not a valid attribute name`, true);
    const out = joinMeshes([run.mesh, ...others], name && isValidAttributeName(name) ? name : undefined);
    run.note(`${1 + others.length} meshes · ${out.faces.length} faces`);
    return out;
  },
});

// ============================================================ Material by Group

/**
 * One scratch mesh per node, only there so applyMaterialParams can build and
 * keep up to date the material it would put on a primitive — which this node
 * then hands out as an extra material slot.
 */
const scratch = createNodeCache<THREE.Mesh>((m) => {
  const mat = m.material;
  if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
  else mat?.dispose();
});

export const MATERIAL_BY_GROUP_NODE = definePolyNode({
  type: "modeling/material-by-group",
  label: "Material by Group",
  category: "modeling",
  group: { domain: "face" },
  inputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: { group: "selected" },
  run: (run) => {
    const params = materialParamsFromValue(run.inputs.material);
    const { mask, indices } = run.group("face");
    if (!params) {
      run.note("Wire a Material — the group keeps the source material until then", true);
      return run.mesh;
    }
    let holder = scratch.get(run.nodeId);
    if (!holder) {
      holder = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
      scratch.set(run.nodeId, holder);
    }
    applyMaterialParams(holder, params, THREE.FrontSide);
    const material = Array.isArray(holder.material) ? holder.material[0] : holder.material;

    // The new slot comes after every slot already in use and after the
    // source's own materials (a previous Material by Group appended its own).
    const current = readAttribute(run.mesh, "face", "material_index")!.values;
    let used = 0;
    for (const v of current) used = Math.max(used, v + 1);
    const slot = Math.max(used, run.sourceMaterialCount);
    const values = Float64Array.from(current, (v, f) => (mask[f] ? slot : v));
    run.note(`${indices.length} faces → material slot ${slot}`);
    // Extra slots start right after the source's: any gap repeats this material.
    return { mesh: setAttribute(run.mesh, "face", "material_index", "int", values), extraMaterials: slots(slot - run.sourceMaterialCount + 1, material) };
  },
});

const slotCache = new WeakMap<THREE.Material, THREE.Material[]>();
/** `count` copies of `material`, the same array while the count holds (see withExtraMaterials). */
function slots(count: number, material: THREE.Material): THREE.Material[] {
  const cached = slotCache.get(material);
  if (cached && cached.length === count) return cached;
  const out = Array.from({ length: Math.max(1, count) }, () => material);
  slotCache.set(material, out);
  return out;
}

export const MODELING_NODES = [JOIN_NODE, MATERIAL_BY_GROUP_NODE];
