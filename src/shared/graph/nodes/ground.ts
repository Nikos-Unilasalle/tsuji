import { NodeDefinition } from "../types";
import { GroundConfig } from "../particleRuntime";

function numberInput(input: unknown, param: unknown, fallback: number): number {
  const raw = input !== undefined ? input : param;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function boolInput(input: unknown, param: unknown, fallback: boolean): boolean {
  const raw = input !== undefined ? input : param;
  return raw === undefined ? fallback : Boolean(raw);
}

/**
 * Ground Node — a horizontal collision plane (Y-normal, at Height) for
 * Particle Simulate: wire its `ground` output into a Particle Simulate's
 * new Ground socket and particles stop sinking through the floor instead
 * of falling forever. Bounce 0 settles particles dead on contact (the
 * "falling point cloud that comes to rest on the ground" case); raise it
 * for a bouncier landing. Friction scales horizontal speed on each
 * contact — 1 slides freely, 0 grips instantly.
 *
 * Pure config bundle like particles/force-field — no GPU state of its own,
 * Particle Simulate's own GPUComputationRenderer owns the collision
 * response (see the ground-response block in particleRuntime.ts's
 * VELOCITY_SHADER and the position clamp in POSITION_SHADER).
 */
export const GROUND_NODE: NodeDefinition = {
  type: "particles/ground",
  label: "Ground",
  category: "particles",
  pure: true,
  inputs: [
    { id: "enabled", label: "Enabled", type: "value" },
    { id: "height", label: "Height (Y)", type: "value" },
    { id: "bounce", label: "Bounce", type: "value" },
    { id: "friction", label: "Friction", type: "value" },
  ],
  outputs: [{ id: "ground", label: "Ground", type: "any" }],
  defaultParams: {
    enabled: 1,
    height: 0,
    bounce: 0,
    friction: 0.9,
  },
  paramFields: [
    { id: "enabled", label: "Enabled", kind: "boolean" },
    { id: "height", label: "Height (Y)", kind: "number", step: 0.1 },
    { id: "bounce", label: "Bounce (0 = settles, 1 = elastic)", kind: "number", step: 0.05 },
    { id: "friction", label: "Friction (1 = frictionless slide, 0 = grips)", kind: "number", step: 0.05 },
  ],
  evaluate: (inputs, params): { ground: GroundConfig } => {
    const ground: GroundConfig = {
      enabled: boolInput(inputs.enabled, params.enabled, true),
      y: numberInput(inputs.height, params.height, 0),
      bounce: Math.max(0, Math.min(1, numberInput(inputs.bounce, params.bounce, 0))),
      friction: Math.max(0, Math.min(1, numberInput(inputs.friction, params.friction, 0.9))),
    };
    return { ground };
  },
};
