import type { ParamFieldDef } from "./types";

/**
 * A pinned param driven by a MIDI controller's knob, fader or button (an Arturia MiniLab…): what a control change
 * does to the value. Pure, for the pinned-param HUD and the tests.
 *
 * How a knob sends its position:
 * - `abs`: the position, 0–127. A fader, or a knob with ends. The value jumps to where the knob is.
 * - `rel64`, `rel2c`, `relsign`: an endless encoder sends steps, not positions, in one of the three usual codings
 *   (Arturia's "Relative #1, #2, #3"). The value moves from where it is, so it never jumps.
 * - `toggle` (a boolean): a button flips it on each press — for a button that sends 127 pressed, 0 released.
 *   `abs` on a boolean follows the button instead: on while ≥ 64.
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
  /** A number's range: where 0 and 127 put it (a field has no range of its own). */
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
  return field.kind === "boolean" ? ["toggle", "abs"] : ["abs", "rel64", "rel2c", "relsign"];
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

/** 1, 2, 5, 10, 20, 50…: the smallest at least x. */
function niceCeil(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

/**
 * A number's range when a knob is first learned, from what the value is now: a fraction 0–1, an angle ±180°, else 0
 * up to a round number past twice the value (and as far below 0 when it is negative).
 */
export function defaultRange(field: ParamFieldDef, current: number): [number, number] {
  if (field.kind === "number" && field.percent) return [0, 1];
  if (field.kind === "number" && field.degrees) return [-Math.PI, Math.PI];
  const a = Math.abs(Number.isFinite(current) ? current : 0);
  const top = a <= 1 ? 1 : niceCeil(a * 2);
  return current < 0 ? [-top, top] : [0, top];
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

/** A new binding for a control, in the field's default mode, its range around the value it has now. */
export function learnBinding(field: BindableField, channel: number, cc: number, current: unknown, port?: string): MidiBinding {
  const binding: MidiBinding = { ...(port ? { port } : {}), channel, cc, mode: modesFor(field)[0] };
  if (field.kind === "number") [binding.min, binding.max] = defaultRange(field, Number(current) || 0);
  return binding;
}

function quantize(value: number, field: BindableField, span: number): number {
  const step = field.kind === "number" ? field.step : undefined;
  if (step && step > 0) {
    const decimals = (String(step).split(".")[1] ?? "").length;
    return Number((Math.round(value / step) * step).toFixed(decimals));
  }
  // Four significant digits of the range: a knob's 128 positions need no more, and the field reads clean.
  const exp = Math.floor(Math.log10(Math.max(1e-9, Math.abs(span)))) - 3;
  const rounded = Math.round(value / 10 ** exp) * 10 ** exp;
  return exp < 0 ? Number(rounded.toFixed(-exp)) : rounded;
}

/**
 * The value a control change gives the param, or undefined when it leaves it as it is.
 * `previous` is the last value this control sent (a toggle flips on the press, not the release).
 */
export function applyCc(field: BindableField, binding: MidiBinding, value: number, current: unknown, previous?: number): unknown {
  const t = Math.max(0, Math.min(127, value)) / 127;
  const delta = relativeDelta(value, binding.mode);
  if (field.kind === "boolean") {
    if (binding.mode === "toggle") return value >= 64 && (previous ?? 0) < 64 ? !current : undefined;
    return value >= 64;
  }
  if (field.kind === "select") {
    const n = field.options.length;
    if (n === 0) return undefined;
    const at = Math.max(0, field.options.indexOf(String(current)));
    const index = binding.mode === "abs" ? Math.round(t * (n - 1)) : Math.max(0, Math.min(n - 1, at + Math.sign(delta)));
    return index === at && field.options.indexOf(String(current)) >= 0 ? undefined : field.options[index];
  }
  const min = binding.min ?? 0;
  const max = binding.max ?? 1;
  const span = max - min;
  if (binding.mode === "abs") return quantize(min + t * span, field, span);
  if (delta === 0) return undefined;
  const now = Number(current) || 0;
  // A step is a 127th of the range — or the field's own step when that is coarser: rounded to it, a finer step would
  // never move the value at all.
  const tick = Math.max(Math.abs(span) / 127, field.kind === "number" && field.step ? field.step : 0) * Math.sign(span || 1);
  let next = now + delta * tick;
  // An encoder stops at the range's ends — but never pulls a value already past one back to it.
  next = delta > 0 ? Math.min(next, Math.max(now, max)) : Math.max(next, Math.min(now, min));
  return quantize(next, field, span);
}

/** Whether a control change is the one a binding listens to. */
export function bindingMatches(b: MidiBinding, port: string, channel: number, cc: number): boolean {
  return b.channel === channel && b.cc === cc && (!b.port || b.port === port);
}

/** "CC 74 · ch 1", as the HUD names a binding. */
export function bindingName(b: MidiBinding): string {
  return `CC ${b.cc} · ch ${b.channel + 1}`;
}
