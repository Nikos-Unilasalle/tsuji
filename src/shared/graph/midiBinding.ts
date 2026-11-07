import type { ParamFieldDef } from "./types";

/**
 * A pinned param driven by a MIDI controller's knob or button (an Arturia MiniLab…): what a control change does to the
 * value. Pure, for the pinned-param HUDs and the tests.
 *
 * Every knob is taken as endless: turned one way it adds a step, the other way it takes one off, from wherever the
 * value is — no range to set, nothing to jump. A binding keeps only its step. The knob sends its turns in one of the
 * three usual codings (Arturia's "Relative #1, #2, #3"), heard when it is learned:
 * - `rel64`: 64 ± the steps (65 up, 63 down).
 * - `rel2c`: 2's complement (1 up, 127 down).
 * - `relsign`: sign bit (1 up, 65 down).
 * A button on a boolean: `toggle` flips it on each press (127 pressed, 0 released); `abs` follows it, on while ≥ 64.
 * `abs` on a number or a menu is a binding from before knobs were all endless: read as 64±.
 */
export type CcMode = "abs" | "rel64" | "rel2c" | "relsign" | "toggle";

export interface MidiBinding {
  /**
   * The input it came in on. A controller often has several (the MiniLab 3: its MIDI port, and others for DAW and
   * Analog Lab control) and may send one knob's move on more than one, the same CC coded differently: listening to
   * all of them makes the value jump between the two readings. Absent on a binding from before: any input.
   */
  port?: string;
  /** 0–15. */
  channel: number;
  cc: number;
  mode: CcMode;
  /** What one notch of the knob adds to a number (stored units: radians for an angle). */
  step?: number;
  /** A range, on bindings saved before the step: ignored (the default step stands in), dropped when a step is set. */
  min?: number;
  max?: number;
}

export const CC_MODE_LABELS: Record<CcMode, string> = {
  abs: "Absolute",
  rel64: "Relative 64±",
  rel2c: "Relative 2's compl.",
  relsign: "Relative sign bit",
  toggle: "Toggle on press",
};

export type BindableField = ParamFieldDef & { kind: "number" | "boolean" | "select" };

export function isBindable(field: ParamFieldDef): field is BindableField {
  return field.kind === "number" || field.kind === "boolean" || field.kind === "select";
}

/** The modes a field can take, the default first. */
export function modesFor(field: BindableField): CcMode[] {
  return field.kind === "boolean" ? ["toggle", "abs"] : ["rel64", "rel2c", "relsign"];
}

/** The steps an encoder message turns, signed; 0 for an absolute mode. */
export function relativeDelta(value: number, mode: CcMode): number {
  switch (mode) {
    case "rel64":
      return value - 64;
    case "rel2c":
      return value < 64 ? value : value - 128;
    case "relsign":
      return value < 64 ? value : -(value - 64);
    default:
      return 0;
  }
}

/**
 * A number's step when a knob is first learned: the field's own, a degree for an angle, a percent for a fraction, else
 * a hundredth of the value's order of magnitude (0.01 for a value around 1, 1 for one in the hundreds).
 */
export function defaultStep(field: ParamFieldDef, current: number): number {
  if (field.kind === "number" && field.step && field.step > 0) return field.step;
  if (field.kind === "number" && field.degrees) return Math.PI / 180;
  if (field.kind === "number" && field.percent) return 0.01;
  const a = Math.abs(Number.isFinite(current) ? current : 0);
  return Math.max(1, 10 ** Math.floor(Math.log10(a || 1))) / 100;
}

/** The step a binding turns a number by: its own, else the default (a binding from before the step had a range). */
export function bindingStep(field: BindableField, binding: MidiBinding, current: number): number {
  if (binding.step !== undefined && Number.isFinite(binding.step) && binding.step !== 0) return binding.step;
  return defaultStep(field, current);
}

/**
 * The way a control sends its moves, guessed from the values it sent while being turned at learn time; null when they
 * say nothing either way (too few, or a single one).
 *
 * A knob with ends (or a fader) sends its position, so it never sends the same value twice running. An endless encoder
 * sends steps, the same value again and again while it turns one way (65 65 65…, or 64 65 64 65… with a rest value
 * between steps): a repeat or a return means relative, and which
 * coding is told by where the values sit — around 64 (64±), near 0 and 127 (2's complement), or 1… up and 65… down
 * (sign bit).
 */
export function detectMode(values: readonly number[]): CcMode | null {
  if (values.length < 3) return null;
  let repeats = 0;
  let returns = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) repeats++;
    if (i >= 2 && values[i] === values[i - 2]) returns++;
  }
  const lowUp = values.some((v) => v >= 1 && v <= 15);
  const highDown = values.some((v) => v >= 113 && v <= 127);
  const nearMid = values.every((v) => v >= 48 && v <= 80);
  // A knob with ends goes somewhere: it neither repeats a value nor keeps coming back to the one before last. An
  // encoder does one or the other — some send a rest value between steps (the MiniLab: 64 65 64 65…) — or, turned
  // fast both ways in 64±, only hugs 64.
  const relative =
    repeats > 0 ||
    returns * 2 >= values.length - 2 ||
    (nearMid && values.some((v) => v < 64) && values.some((v) => v > 64) && new Set(values).size <= 6);
  if (!relative) return "abs";
  if (nearMid) return "rel64";
  if (lowUp && values.some((v) => v >= 65 && v <= 79)) return "relsign";
  if (lowUp || highDown) return "rel2c";
  return null;
}

/** A new binding for a control, in the field's default mode; a number gets its default step. */
export function learnBinding(field: BindableField, channel: number, cc: number, current: unknown, port?: string): MidiBinding {
  const binding: MidiBinding = { ...(port ? { port } : {}), channel, cc, mode: modesFor(field)[0] };
  if (field.kind === "number") binding.step = defaultStep(field, Number(current) || 0);
  return binding;
}

/** The decimals a step is written with: what a sum of steps is rounded to, so 0.1 + 0.2 reads 0.3. */
function decimalsOf(step: number): number {
  const text = String(Math.abs(step));
  const exp = text.match(/e-(\d+)$/);
  if (exp) return Math.min(12, Number(exp[1]) + ((text.split("e")[0].split(".")[1] ?? "").length));
  return Math.min(12, (text.split(".")[1] ?? "").length);
}

/**
 * The value a control change gives the param, or undefined when it leaves it as it is.
 * `previous` is the last value this control sent (a toggle flips on the press, not the release).
 */
export function applyCc(field: BindableField, binding: MidiBinding, value: number, current: unknown, previous?: number): unknown {
  if (field.kind === "boolean") {
    if (binding.mode === "toggle") return value >= 64 && (previous ?? 0) < 64 ? !current : undefined;
    return value >= 64;
  }
  const mode = binding.mode === "abs" || binding.mode === "toggle" ? "rel64" : binding.mode;
  const delta = relativeDelta(value, mode);
  if (delta === 0) return undefined;
  if (field.kind === "select") {
    const n = field.options.length;
    if (n === 0) return undefined;
    const known = field.options.indexOf(String(current));
    const at = Math.max(0, known);
    const index = Math.max(0, Math.min(n - 1, at + Math.sign(delta)));
    return index === at && known >= 0 ? undefined : field.options[index];
  }
  const now = Number(current) || 0;
  const step = bindingStep(field, binding, now);
  const decimals = Math.max(decimalsOf(step), field.step ? decimalsOf(field.step) : 0);
  return Number((now + delta * step).toFixed(decimals));
}

/** Whether a control change is the one a binding listens to. */
export function bindingMatches(b: MidiBinding, port: string, channel: number, cc: number): boolean {
  return b.channel === channel && b.cc === cc && (!b.port || b.port === port);
}

/** "CC 74 · ch 1", as the HUD names a binding. */
export function bindingName(b: MidiBinding): string {
  return `CC ${b.cc} · ch ${b.channel + 1}`;
}
