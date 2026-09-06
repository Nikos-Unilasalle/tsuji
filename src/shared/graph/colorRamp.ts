import * as THREE from "three";

/**
 * A Blender-style color ramp: named stops along 0-1, sampled by interpolating
 * between whichever two straddle a given t. Used as a param kind
 * ("color_ramp"), currently by Color Palette List.
 *
 * Lives here rather than next to its editor because node `evaluate()` runs
 * in both windows and in headless tests — a graph node must never have to
 * import a React component to read one of its own params. See
 * profileCurve.ts for the same split on a 1-D value curve.
 */
export interface ColorStop {
  /** 0 to 1 along the ramp. */
  position: number;
  color: THREE.Color;
}

export type ColorRampInterpolation = "linear" | "constant";

export const DEFAULT_COLOR_STOPS: ColorStop[] = [
  { position: 0, color: new THREE.Color(0x38bdf8) },
  { position: 1, color: new THREE.Color(0xec4899) },
];

/** What a "color_ramp" ParamFieldDef's value actually is — stops plus how to blend between them, as one param. */
export interface ColorRamp {
  stops: ColorStop[];
  interpolation: ColorRampInterpolation;
}

export const DEFAULT_COLOR_RAMP: ColorRamp = { stops: DEFAULT_COLOR_STOPS, interpolation: "linear" };

export function sampleColorRamp(ramp: ColorRamp | undefined | null, t: number): THREE.Color {
  return evalColorRamp(ramp?.stops, t, ramp?.interpolation ?? "linear");
}

function toColor(c: unknown): THREE.Color {
  if (c instanceof THREE.Color) return c.clone();
  if (typeof c === "number" || typeof c === "string") return new THREE.Color(c);
  if (c && typeof c === "object") {
    const obj = c as { r?: unknown; g?: unknown; b?: unknown };
    return new THREE.Color(Number(obj.r) || 0, Number(obj.g) || 0, Number(obj.b) || 0);
  }
  return new THREE.Color(0xffffff);
}

/** Evaluates a color ramp at parameter t in [0, 1]. */
export function evalColorRamp(
  stops: ColorStop[] | undefined | null,
  t: number,
  interpolation: ColorRampInterpolation = "linear",
): THREE.Color {
  const pts =
    stops && stops.length > 0
      ? [...stops]
          .map((s) => ({ position: Number(s.position) || 0, color: toColor(s.color) }))
          .sort((a, b) => a.position - b.position)
      : DEFAULT_COLOR_STOPS;
  if (pts.length === 1) return pts[0].color.clone();

  const clampedT = Math.max(0, Math.min(1, t));
  if (clampedT <= pts[0].position) return pts[0].color.clone();
  if (clampedT >= pts[pts.length - 1].position) return pts[pts.length - 1].color.clone();

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (clampedT < a.position || clampedT > b.position) continue;
    if (interpolation === "constant") return a.color.clone();
    const span = b.position - a.position;
    const localT = span > 1e-6 ? (clampedT - a.position) / span : 0;
    return a.color.clone().lerp(b.color, localT);
  }
  return pts[pts.length - 1].color.clone();
}
