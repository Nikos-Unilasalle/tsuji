import * as THREE from "three";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { COMMON_MATERIAL_PARAM_FIELDS, asColor, extractMaterialParams, numberInput } from "./object";

/** Standard Material node — a reusable surface description wired into an object's `material` input. */
export const MATERIAL_NODE: NodeDefinition = {
  type: "material/standard",
  label: "Material",
  category: "texture",
  inputs: [
    { id: "color", label: "Color", type: "color" },
    { id: "emissive", label: "Emissive Color", type: "color" },
    { id: "emissiveIntensity", label: "Emissive Intensity", type: "value" },
    { id: "shadeless", label: "Shadeless", type: "value" },
    { id: "roughness", label: "Roughness", type: "value" },
    { id: "metalness", label: "Metalness", type: "value" },
    { id: "wireframe", label: "Wireframe", type: "value" },
    { id: "opacity", label: "Opacity", type: "value" },
    { id: "transmission", label: "Transmission (Glass)", type: "value" },
    { id: "thickness", label: "Glass Thickness", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    color: new THREE.Color(0xffffff),
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
    shadeless: 0,
    roughness: 0.4,
    metalness: 0.1,
    wireframe: 0,
    opacity: 1.0,
    transmission: 0,
    thickness: 0.5,
  },
  paramFields: [...COMMON_MATERIAL_PARAM_FIELDS],
  evaluate: (inputs, params) => ({ material: extractMaterialParams(inputs, params) }),
};

const shadowCatcherCache = createNodeCache<THREE.ShadowMaterial>((m) => m.dispose());

/**
 * Shadow Catcher Material node — renders an invisible surface that only catches and displays
 * shadows cast upon it (ideal for ground planes, backdrops, and product staging).
 */
export const MATERIAL_SHADOW_CATCHER_NODE: NodeDefinition = {
  type: "material/shadow-catcher",
  label: "Shadow Catcher",
  category: "texture",
  inputs: [
    { id: "opacity", label: "Shadow Opacity", type: "value" },
    { id: "color", label: "Shadow Color", type: "color" },
    { id: "doubleSided", label: "Double Sided", type: "value" },
  ],
  outputs: [{ id: "material", label: "Material", type: "material" }],
  defaultParams: {
    opacity: 0.6,
    color: new THREE.Color(0x000000),
    doubleSided: 1,
  },
  paramFields: [
    { id: "opacity", label: "Shadow Opacity", kind: "number", step: 0.05 },
    { id: "color", label: "Shadow Color", kind: "color" },
    { id: "doubleSided", label: "Double Sided", kind: "boolean" },
  ],
  evaluate: (inputs, params, ctx) => {
    let mat = shadowCatcherCache.get(ctx.nodeId);
    if (!mat) {
      mat = new THREE.ShadowMaterial({
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1.0,
        polygonOffsetUnits: -4.0,
      });
      (mat as any).__isSharedCustom = true;
      shadowCatcherCache.set(ctx.nodeId, mat);
    }

    const opacity = Math.min(1, Math.max(0, numberInput(inputs.opacity, params.opacity, 0.6)));
    const color = asColor(inputs.color, asColor(params.color, new THREE.Color(0x000000)));
    const doubleSided = inputs.doubleSided !== undefined ? Number(inputs.doubleSided) > 0 : Boolean(params.doubleSided ?? true);

    mat.opacity = opacity;
    mat.color.copy(color);
    mat.side = doubleSided ? THREE.DoubleSide : THREE.FrontSide;

    return {
      material: {
        customMaterial: mat,
        color,
        opacity,
      },
    };
  },
};

