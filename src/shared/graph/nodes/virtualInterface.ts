import { NodeDefinition } from "../types";

/**
 * Virtual Interface — a control surface for playing a scene live. It draws every pinned param (the ones pinned from
 * the param panel) as hardware in the 3D view: a knob for a number, a switch for an on/off, a stepped selector for a
 * menu, a knob per axis for a vector (whose axes can be linked to turn together — kept in `linked`). It evaluates to nothing; it is the HUD it shows (see windows/VirtualInterfaceHUD.tsx), and while it is shown
 * it stands in for the plain Pinned Params list.
 *
 * A knob needs a range a number field does not carry, so each knob gets one guessed from its value (defaultRange) and
 * kept, once edited, in `ranges` — keyed "nodeId:paramId" ("nodeId:paramId.x" for a vector's axis), in the units the panel shows (degrees, percent).
 */

export const VI_ACCENTS = ["theme", "magenta", "cyan", "amber", "lime", "white"] as const;
export type ViAccent = (typeof VI_ACCENTS)[number];
export const VI_ACCENT_COLOR: Record<ViAccent, string> = {
  // The interface theme's own accent, followed when the theme changes.
  theme: "var(--accent-color, #38bdf8)",
  magenta: "#e879f9",
  cyan: "#22d3ee",
  amber: "#fbbf24",
  lime: "#a3e635",
  white: "#f1f5f9",
};
export const VI_SIZES = ["S", "M", "L"] as const;
export type ViSize = (typeof VI_SIZES)[number];
/** A knob's diameter, in px. */
export const VI_KNOB_SIZE: Record<ViSize, number> = { S: 44, M: 60, L: 84 };

export type ViRange = [min: number, max: number];

/** A round number at or above x: 1, 2, 5, 10, 20, 50… */
function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x - 1e-12) return m * p;
  return 10 * p;
}

/** The range a field's label spells out in its brackets — "Voices (1–16, 1 = mono)", "Pan (−1 left, 1 right)" —
 * as the lowest and highest numbers there; null when it gives fewer than two. */
export function labelRange(label: string): ViRange | null {
  const nums: number[] = [];
  for (const [, inner] of label.matchAll(/\(([^)]*)\)/g)) {
    for (const m of inner.replace(/−/g, "-").matchAll(/(?<![\w.])-?\d+(?:\.\d+)?/g)) nums.push(Number(m[0]));
  }
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return hi > lo ? [lo, hi] : null;
}

/** A knob's range when none was set: the one the label gives, 0–100 for a percent, a turn for an angle, 0–1 for a
 * value in it, otherwise a round span with room either side of the value. */
export function defaultRange(value: number, field: { degrees?: boolean; percent?: boolean; label?: string; step?: number } = {}): ViRange {
  const label = field.label ?? "";
  const fromLabel = labelRange(label);
  if (fromLabel && value >= fromLabel[0] && value <= fromLabel[1]) return fromLabel;
  if (field.percent) return [0, 100];
  if (field.degrees) return value < 0 ? [-180, 180] : [0, 360];
  const v = Number.isFinite(value) ? value : 0;
  if (/semitone/i.test(label) && Math.abs(v) <= 24) return [-24, 24];
  // A multiplier ("Brightness ×") reads round 1: room to double it.
  if (/×/.test(label) && v >= 0 && v <= 2) return [0, 2];
  // A whole number (a count, a step) needs more than 0–1 to turn through.
  if (field.step !== undefined && field.step >= 1) {
    const m = niceCeil(Math.max(Math.abs(v) * 2, 10));
    return v < 0 ? [-m, m] : [0, m];
  }
  if (v >= 0 && v <= 1) return [0, 1];
  const m = niceCeil(Math.abs(v) * 2);
  return v < 0 ? [-m, m] : [0, m];
}

/** Where a value sits on its knob's travel, 0–1 (clamped). */
export function knobFraction(value: number, [min, max]: ViRange): number {
  if (!(max > min)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** The value a drag of `pixels` (up is positive) from `start` gives: the whole range in `travel` px, a tenth as fast
 * when fine, snapped to `step` when one is given, kept in range. */
export function dragValue(start: number, pixels: number, range: ViRange, opts: { travel?: number; fine?: boolean; step?: number } = {}): number {
  const [min, max] = range;
  const travel = (opts.travel ?? 200) * (opts.fine ? 10 : 1);
  let v = start + (pixels / travel) * (max - min);
  if (opts.step && opts.step > 0 && !opts.fine) v = Math.round(v / opts.step) * opts.step;
  v = Math.min(max, Math.max(min, v));
  return Number(v.toFixed(6));
}

export function rangeKey(nodeId: string, paramId: string): string {
  return `${nodeId}:${paramId}`;
}

/** The range stored for a knob, if it is a usable one. */
export function storedRange(ranges: unknown, key: string): ViRange | null {
  const r = ranges && typeof ranges === "object" ? (ranges as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(r) || r.length !== 2) return null;
  const [a, b] = r.map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
}

export const VIRTUAL_INTERFACE_NODE: NodeDefinition = {
  type: "io/virtual-interface",
  label: "Virtual Interface",
  category: "io",
  inputs: [],
  outputs: [],
  defaultParams: { title: "Live", show: true, accent: "theme", size: "M", ranges: {}, linked: {} },
  paramFields: [
    { id: "title", label: "Title", kind: "text" },
    { id: "show", label: "Show in the 3D view (pin params from the panel to add controls)", kind: "boolean" },
    { id: "accent", label: "Accent", kind: "select", options: [...VI_ACCENTS] },
    { id: "size", label: "Control size", kind: "select", options: [...VI_SIZES] },
  ],
  evaluate: () => ({}),
};

export type ViAxis = "x" | "y" | "z";

/** A vector axis's range when none was set: a scale from 0 with room to double, an angle a turn either way, anything
 * else (a position, an offset) the same distance either side of zero, wide enough to move. */
export function vectorAxisRange(value: number, field: { degrees?: boolean; label?: string } = {}): ViRange {
  const v = Number.isFinite(value) ? value : 0;
  if (field.degrees) return [-180, 180];
  if (/scale|size/i.test(field.label ?? "") && v >= 0) return [0, niceCeil(Math.max(v * 2, 2))];
  const m = niceCeil(Math.max(Math.abs(v) * 2, 5));
  return [-m, m];
}

/** A vector knob turned while its axes are linked: every axis moves by what the turned one moved since the drag began
 * — the same amount, not the same ratio, so an axis at zero follows too. */
export function linkedVector(start: Record<ViAxis, number>, axis: ViAxis, next: number, axes: readonly ViAxis[]): Record<ViAxis, number> {
  const delta = next - start[axis];
  const out = { ...start };
  for (const k of axes) out[k] = k === axis ? next : start[k] + delta;
  return out;
}
