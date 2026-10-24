import { GaitStyle, NATURAL_STYLE } from "./gaitModel";

/**
 * Named gaits: a style (multipliers on the natural, physical walk — see
 * gaitModel.ts) plus the speed it is usually done at, for an adult with a
 * 0.95 m hip height. Because the style is relative, a preset fits any
 * skeleton: a short-legged one doing "March" takes shorter, quicker steps,
 * and the HUD scales the speed by √(hip height) so it matches the Froude
 * number too.
 */

export type GaitMode = "auto" | "walk" | "run";

export interface GaitPreset {
  label: string;
  /** One line, shown as the button's tooltip. */
  hint: string;
  /** Metres per second for an adult (Drive / In Place). */
  speed: number;
  gait: GaitMode;
  style: Partial<GaitStyle>;
}

export const GAIT_PRESETS = {
  natural: { label: "Natural", hint: "The physical walk of this body: every multiplier at 1", speed: 1.3, gait: "auto", style: {} },
  stroll: { label: "Stroll", hint: "Unhurried: short arm swing, a slight lean back", speed: 0.9, gait: "walk", style: { stride: 0.92, armSwing: 0.6, bob: 0.85, clearance: 0.8, lean: -1.5 } },
  brisk: {
    label: "Brisk",
    hint: "Late for a train: long strides, pumping arms, leaning into it",
    speed: 1.85,
    gait: "walk",
    style: { stride: 1.08, armSwing: 1.5, armBend: 0.3, lean: 2, leanResponse: 1.3, pelvisTurn: 1.3 },
  },
  jog: { label: "Jog", hint: "An easy run, both feet leaving the ground", speed: 2.8, gait: "run", style: { armSwing: 0.9 } },
  sprint: { label: "Sprint", hint: "Flat out: huge strides, high knees, driving arms", speed: 6.5, gait: "run", style: { stride: 1.12, armSwing: 1.4, clearance: 1.35, lean: 4, contact: -0.03 } },
  sneak: {
    label: "Sneak",
    hint: "Crouched, careful, feet lifted high and set down softly",
    speed: 0.7,
    gait: "walk",
    style: { crouch: 0.17, stride: 0.82, clearance: 1.7, swingPeak: 0.5, heelLift: 0.4, contact: 0.1, armSwing: 0.3, armBend: 0.55, armForward: 22, lean: 14, bob: 0.4, headStabilize: 0.9 },
  },
  tiptoe: {
    label: "Tiptoe",
    hint: "On the balls of the feet, arms out for balance",
    speed: 0.6,
    gait: "walk",
    style: { heelLift: 3.6, stride: 0.6, clearance: 1.2, contact: 0.04, armSwing: 0.35, armSpread: 22, armBend: 0.3, bob: 0.6, sway: 0.7 },
  },
  march: {
    label: "March",
    hint: "High knees, stiff swinging arms, chest up",
    speed: 1.4,
    gait: "walk",
    style: { clearance: 2.6, swingPeak: 0.5, armSwing: 2.2, heelLift: 0.6, bob: 1.2, lean: -2.5, pelvisTurn: 0.4, sway: 0.7, headStabilize: 0.9, contact: -0.02 },
  },
  catwalk: {
    label: "Catwalk",
    hint: "One foot in front of the other, the hips rolling",
    speed: 1.2,
    gait: "walk",
    style: { stepWidth: -0.15, pelvisDrop: 2.6, pelvisTurn: 1.8, sway: 2.2, stride: 1.05, armSwing: 0.8, armSpread: 6, lean: -3, heelLift: 1.4 },
  },
  swagger: {
    label: "Swagger",
    hint: "Wide stance, rolling shoulders and hips, arms out",
    speed: 1.1,
    gait: "walk",
    style: { stepWidth: 1.6, pelvisTurn: 2.2, armSwing: 1.6, armSpread: 14, kneeOut: 12, sway: 1.8, bob: 1.3, lean: -4, stride: 0.95 },
  },
  bouncy: {
    label: "Bouncy",
    hint: "Springing up on every step, light on the feet",
    speed: 1.3,
    gait: "walk",
    style: { bob: 2.4, stride: 0.86, clearance: 1.5, heelLift: 1.7, contact: -0.08, armSwing: 1.5, armBend: 0.2, headStabilize: 0.1 },
  },
  tired: {
    label: "Tired",
    hint: "Dragging feet, slumped forward, arms hanging",
    speed: 0.7,
    gait: "walk",
    style: { stride: 0.7, clearance: 0.45, heelLift: 0.3, armSwing: 0.25, lean: 14, headStabilize: 0.1, bob: 0.7, sway: 1.4, stepWidth: 1.25, crouch: 0.04 },
  },
  elderly: {
    label: "Elderly",
    hint: "Short careful steps, a wide base, a stooped back",
    speed: 0.7,
    gait: "walk",
    style: { stride: 0.62, contact: 0.1, clearance: 0.55, heelLift: 0.4, stepWidth: 1.4, armSwing: 0.35, armBend: 0.3, lean: 11, crouch: 0.05, pelvisTurn: 0.4, sway: 1.2 },
  },
  limp: { label: "Limp", hint: "Favouring the right leg: a short, quick stance on it", speed: 0.8, gait: "walk", style: { limp: 1, stride: 0.8, sway: 1.6, armSwing: 0.7, pelvisDrop: 1.6 } },
  groucho: {
    label: "Groucho",
    hint: "Deep knee bend, long gliding strides, the head perfectly level",
    speed: 1.3,
    gait: "walk",
    style: { crouch: 0.3, stride: 1.35, clearance: 0.6, lean: 18, armSwing: 0.3, armBend: 0.4, headStabilize: 1, bob: 0.3 },
  },
  zombie: {
    label: "Zombie",
    hint: "Arms reaching out, a dragging shuffle, lurching side to side",
    speed: 0.5,
    gait: "walk",
    style: { stride: 0.55, clearance: 0.25, heelLift: 0, armForward: 80, armSwing: 0.1, armSpread: 8, lean: 6, sway: 2.6, pelvisDrop: 2, kneeOut: 10, limp: 0.5, contact: 0.12, headStabilize: 0 },
  },
} satisfies Record<string, GaitPreset>;

export type GaitPresetKey = keyof typeof GAIT_PRESETS;
export const GAIT_PRESET_KEYS = Object.keys(GAIT_PRESETS) as GaitPresetKey[];

/** Every style key, at the preset's value or natural — applying a preset resets what it does not mention. */
export function presetStyle(key: GaitPresetKey): GaitStyle {
  const preset: GaitPreset = GAIT_PRESETS[key];
  return { ...NATURAL_STYLE, ...preset.style };
}

/** Adult preset speed for a body of this hip height (equal Froude number). */
export function presetSpeed(key: GaitPresetKey, hipHeight: number): number {
  const preset: GaitPreset = GAIT_PRESETS[key];
  return preset.speed * Math.sqrt(Math.max(0.01, hipHeight) / 0.95);
}
