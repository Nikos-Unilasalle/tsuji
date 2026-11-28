import * as THREE from "three";
import { createNodeCache } from "../nodeCaches";
import { isValidAttributeName, readAttribute, setAttribute } from "../mesh/polyAttributes";
import { joinMeshes } from "../mesh/join";
import { elementNormals, elementPositions } from "../mesh/selectOps";
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
  category: "material",
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

// ============================================================ Group to Points

/**
 * The bridge from groups to the list world: the positions, normals and a
 * scale attribute of a group's points (or face centres), as aligned lists —
 * wire them straight into Instance on Points' Points / Ups / Scales, or any
 * list node.
 */
export const GROUP_TO_POINTS_NODE = definePolyNode({
  type: "modeling/group-to-points",
  label: "Group to Points",
  category: "instance",
  dependsOnPose: true,
  group: { domain: "choose", defaultDomain: "point" },
  outputs: [
    { id: "points", label: "Points", type: "list" },
    { id: "normals", label: "Normals", type: "list" },
    { id: "scales", label: "Scales", type: "list" },
    { id: "indices", label: "Indices (list)", type: "list" },
    { id: "count", label: "Count", type: "value" },
  ],
  defaultParams: { domain: "point", group: "", space: "world", scaleAttribute: "pscale" },
  paramFields: [
    { id: "space", label: "Space", kind: "select", options: ["world", "local"] },
    { id: "scaleAttribute", label: "Scale Attribute (float; missing = 1)", kind: "text" },
  ],
  run: (run) => {
    const raw = run.str("domain", "point");
    const domain = raw === "face" || raw === "edge" || raw === "corner" ? raw : "point";
    const { indices } = run.group(domain);
    const pos = elementPositions(run.mesh, domain);
    const nrm = elementNormals(run.mesh, domain);
    const scaleName = run.str("scaleAttribute", "pscale").trim();
    const sc = scaleName ? readAttribute(run.mesh, domain, scaleName) : null;
    const world = run.str("space", "world") === "world";
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(run.worldMatrix);
    const points: THREE.Vector3[] = [];
    const normals: THREE.Vector3[] = [];
    const scales: number[] = [];
    for (const i of indices) {
      const p = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const n = new THREE.Vector3(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
      if (world) {
        p.applyMatrix4(run.worldMatrix);
        n.applyMatrix3(normalMatrix).normalize();
      }
      points.push(p);
      normals.push(n);
      scales.push(sc ? sc.values[i * sc.size] : 1);
    }
    run.note(`${points.length} points`);
    return { mesh: run.mesh, outputs: { points, normals, scales, indices, count: points.length } };
  },
});

export const MODELING_NODES = [JOIN_NODE, MATERIAL_BY_GROUP_NODE, GROUP_TO_POINTS_NODE];
