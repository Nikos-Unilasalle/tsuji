import * as THREE from "three";
import { NodeDefinition } from "../types";
import { FORCE_FIELD_TYPES, ForceFieldDescriptor, ForceFieldType } from "../particleRuntime";

function asVector(v: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  if (v instanceof THREE.Vector3) return v;
  return fallback;
}

function numberInput(input: unknown, param: unknown, fallback: number): number {
  const raw = input !== undefined ? input : param;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function asFieldType(v: unknown): ForceFieldType {
  return (FORCE_FIELD_TYPES as readonly string[]).includes(v as string) ? (v as ForceFieldType) : "attractor";
}

/**
 * Force Field Node — a Blender-style field for particles/simulate: wire one
 * or more into a Particle Simulate's growing Force Field sockets and they
 * sum together in the velocity shader (see forceFieldContribution() in
 * particleRuntime.ts). Pure config bundle, like particles/emitter — no GPU
 * state of its own, the sim owns that.
 */
export const FORCE_FIELD_NODE: NodeDefinition = {
  type: "particles/force-field",
  label: "Force Field",
  category: "particles",
  pure: true,
  inputs: [
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "position", label: "Position", type: "vector" },
    { id: "axis", label: "Axis / Direction", type: "vector" },
    { id: "strength", label: "Strength", type: "value" },
    { id: "radius", label: "Radius", type: "value" },
    { id: "scale", label: "Turbulence Scale", type: "value" },
    { id: "speed", label: "Turbulence Speed", type: "value" },
  ],
  outputs: [{ id: "field", label: "Field", type: "any" }],
  defaultParams: {
    fieldType: "attractor",
    position: new THREE.Vector3(0, 0, 0),
    axis: new THREE.Vector3(0, 1, 0),
    strength: 2,
    // 0 = infinite reach, same convention as Particle Simulate's Bounds Radius.
    radius: 0,
    scale: 1,
    speed: 0.1,
  },
  paramFields: [
    { id: "fieldType", label: "Type", kind: "select", options: [...FORCE_FIELD_TYPES] },
    { id: "position", label: "Position", kind: "vector" },
    { id: "strength", label: "Strength", kind: "number", step: 0.5 },
    { id: "radius", label: "Radius (0 = infinite)", kind: "number", step: 0.5 },
    { id: "axis", label: "Axis / Direction", kind: "vector", group: "Vortex / Wind" },
    { id: "scale", label: "Scale", kind: "number", step: 0.1, group: "Turbulence" },
    { id: "speed", label: "Speed", kind: "number", step: 0.05, group: "Turbulence" },
  ],
  evaluate: (inputs, params): { field: ForceFieldDescriptor } => {
    const basePos = asVector(inputs.position, asVector(params.position, new THREE.Vector3()));
    const baseAxis = asVector(inputs.axis, asVector(params.axis, new THREE.Vector3(0, 1, 0)));
    const pos = basePos.clone();
    const axis = baseAxis.clone().normalize();

    if (inputs.matrix instanceof THREE.Matrix4) {
      pos.applyMatrix4(inputs.matrix);
      axis.transformDirection(inputs.matrix).normalize();
    }

    const field: ForceFieldDescriptor = {
      type: asFieldType(params.fieldType),
      position: pos,
      axis,
      strength: numberInput(inputs.strength, params.strength, 2),
      radius: numberInput(inputs.radius, params.radius, 0),
      scale: numberInput(inputs.scale, params.scale, 1),
      speed: numberInput(inputs.speed, params.speed, 0.1),
    };
    return { field };
  },
};
