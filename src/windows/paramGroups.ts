import { ParamFieldDef } from "../shared/graph/types";

/**
 * Which collapsible section of the param panel a field belongs to.
 *
 * A field can name its own (`group`), and most of the fiddly nodes do. What
 * makes this worth its own module is the *fallback*: for a field that names
 * nothing, the section is inferred from the field's id. That inference is
 * convenient — every node with a `location`/`rotation`/`scale` gets a
 * Transform section for free, without each node repeating itself — and it is
 * a trap, because it fires on any node that happens to reuse one of those
 * words for something else.
 *
 * Dry Brush found the trap: its stroke angle, called `angle`, landed in
 * "Light Settings" on a post-process node, and that section is collapsed by
 * default — so the field was simply not on screen. Its speck size, called
 * `scale`, was pulled out of the list into a Transform section of its own.
 *
 * Extracted from ParamPanel.tsx so the rule can be tested without loading the
 * panel (and its stylesheet) — see paramGroups.test.ts, which pins that no
 * post-process field falls into a section meant for objects and lights.
 */

const TRANSFORM_IDS = ["location", "rotation", "scale", "position", "transform"];

const MATERIAL_IDS = [
  "color",
  "emissive",
  "emissiveintensity",
  "shadeless",
  "roughness",
  "metalness",
  "wireframe",
  "wireframelinewidth",
  "opacity",
];

const LENS_IDS = ["fov", "near", "far"];

const LIGHT_IDS = ["intensity", "distance", "decay", "angle", "penumbra", "castshadow"];

/** The default section: flat, and open when the panel first shows a node. */
export const DEFAULT_GROUP = "General";

export function getGroupName(field: ParamFieldDef): string {
  if (field.group) return field.group;

  const id = field.id.toLowerCase();
  if (TRANSFORM_IDS.includes(id)) return "Transform";
  if (MATERIAL_IDS.includes(id)) return "Material";
  if (id.includes("uv") || id.includes("texture") || id.includes("normal") || field.kind === "file") {
    return "Texture & Files";
  }
  if (LENS_IDS.includes(id)) return "Lens & Optics";
  if (LIGHT_IDS.includes(id)) return "Light Settings";
  return DEFAULT_GROUP;
}
