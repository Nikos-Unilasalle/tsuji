import * as THREE from "three";
import { NodeDefinition } from "../types";

/** Constant Color node — outputs a THREE.Color specified by parameter. */
export const COLOR_CONSTANT_NODE: NodeDefinition = {
  type: "color/constant",
  label: "Color",
  category: "math",
  pure: true,
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: "color" }],
  defaultParams: { color: new THREE.Color(0xffffff) },
  paramFields: [{ id: "color", label: "Color", kind: "color" }],
  evaluate: (_inputs, params) => {
    const c = params.color instanceof THREE.Color ? params.color : new THREE.Color(0xffffff);
    return { out: c.clone() };
  },
};

/** Compose Color node — combines R, G, B values (0..1 range) into a THREE.Color. */
export const COLOR_COMPOSE_NODE: NodeDefinition = {
  type: "color/compose",
  label: "Compose Color",
  category: "compose",
  pure: true,
  inputs: [
    { id: "r", label: "R", type: "value" },
    { id: "g", label: "G", type: "value" },
    { id: "b", label: "B", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "color" }],
  defaultParams: { r: 1, g: 1, b: 1 },
  paramFields: [
    { id: "r", label: "Red (0..1)", kind: "number" },
    { id: "g", label: "Green (0..1)", kind: "number" },
    { id: "b", label: "Blue (0..1)", kind: "number" },
  ],
  evaluate: (inputs, params) => {
    const r = inputs.r !== undefined ? Number(inputs.r) || 0 : Number(params.r) || 0;
    const g = inputs.g !== undefined ? Number(inputs.g) || 0 : Number(params.g) || 0;
    const b = inputs.b !== undefined ? Number(inputs.b) || 0 : Number(params.b) || 0;

    const color = new THREE.Color(
      Math.min(1, Math.max(0, r)),
      Math.min(1, Math.max(0, g)),
      Math.min(1, Math.max(0, b)),
    );
    return { out: color };
  },
};

/** Decompose Color node — extracts R, G, B scalar channels from a THREE.Color. */
export const COLOR_DECOMPOSE_NODE: NodeDefinition = {
  type: "color/decompose",
  label: "Decompose Color",
  category: "compose",
  pure: true,
  inputs: [{ id: "color", label: "Color", type: "color" }],
  outputs: [
    { id: "r", label: "R", type: "value" },
    { id: "g", label: "G", type: "value" },
    { id: "b", label: "B", type: "value" },
  ],
  defaultParams: {},
  evaluate: (inputs) => {
    const c = inputs.color instanceof THREE.Color ? inputs.color : new THREE.Color(0xffffff);
    return { r: c.r, g: c.g, b: c.b };
  },
};

const COLOR_OPS = ["mix", "multiply", "add"];

/** Color Math node — mixes or blends two colors based on Factor. */
export const COLOR_MATH_NODE: NodeDefinition = {
  type: "color/math",
  label: "Color Math",
  category: "math",
  pure: true,
  inputs: [
    { id: "a", label: "A", type: "color" },
    { id: "b", label: "B", type: "color" },
    { id: "factor", label: "Factor", type: "value" },
  ],
  outputs: [{ id: "out", label: "Out", type: "color" }],
  defaultParams: { op: "mix", factor: 0.5 },
  paramFields: [
    { id: "op", label: "Operation", kind: "select", options: COLOR_OPS },
    { id: "factor", label: "Factor (0..1)", kind: "number" },
  ],
  evaluate: (inputs, params) => {
    const a = inputs.a instanceof THREE.Color ? inputs.a : new THREE.Color(0x000000);
    const b = inputs.b instanceof THREE.Color ? inputs.b : new THREE.Color(0xffffff);
    const factor = Math.min(1, Math.max(0, inputs.factor !== undefined ? Number(inputs.factor) || 0 : Number(params.factor) || 0.5));
    const op = String(params.op || "mix");

    const out = a.clone();
    if (op === "mix") {
      out.lerp(b, factor);
    } else if (op === "multiply") {
      const blended = a.clone().multiply(b);
      out.lerp(blended, factor);
    } else if (op === "add") {
      const blended = new THREE.Color(
        Math.min(1, a.r + b.r),
        Math.min(1, a.g + b.g),
        Math.min(1, a.b + b.b),
      );
      out.lerp(blended, factor);
    }

    return { out };
  },
};
