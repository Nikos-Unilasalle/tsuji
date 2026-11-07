import type { ParamFieldDef } from "./types";

/**
 * One axis of a vector param pinned on its own: the ref's paramId is "position.y", the key the keyframes already use
 * for an axis. The HUDs show it as a number row (so a MIDI knob can drive it) and write it back as the whole vector
 * with only that axis changed.
 */
export type Axis = "x" | "y" | "z";

const AXES: readonly Axis[] = ["x", "y", "z"];

/** "position.y" → { baseId: "position", axis: "y" }; null for a param pinned whole. */
export function splitComponentId(paramId: string): { baseId: string; axis: Axis } | null {
  const dot = paramId.lastIndexOf(".");
  if (dot <= 0) return null;
  const axis = paramId.slice(dot + 1) as Axis;
  return AXES.includes(axis) ? { baseId: paramId.slice(0, dot), axis } : null;
}

/** Whether a vector value has two axes (a Vector2, [x, y], {x, y}) rather than three. */
export function is2DVector(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 2;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return "x" in v && "y" in v && !("z" in v) && (v as { isVector3?: boolean }).isVector3 !== true;
  }
  return false;
}

export function vectorAxes(value: unknown): Axis[] {
  return is2DVector(value) ? ["x", "y"] : ["x", "y", "z"];
}

/** One axis of a vector value, 0 when absent. */
export function readComponent(value: unknown, axis: Axis): number {
  const i = AXES.indexOf(axis);
  const n = Array.isArray(value)
    ? Number(value[i])
    : value && typeof value === "object"
      ? Number((value as Record<string, unknown>)[axis])
      : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * The vector with one axis set, in the shape it came in: an array stays an array, a THREE vector a vector of the same
 * class (cloned), a plain object a plain object.
 */
export function withComponent(value: unknown, axis: Axis, n: number): unknown {
  if (Array.isArray(value)) {
    const next = [...value];
    while (next.length < (is2DVector(value) ? 2 : 3)) next.push(0);
    next[AXES.indexOf(axis)] = n;
    return next;
  }
  if (value && typeof value === "object") {
    const clone = (value as { clone?: () => unknown }).clone;
    if (typeof clone === "function") {
      const next = clone.call(value) as Record<string, number>;
      next[axis] = n;
      return next;
    }
    return { ...(value as object), [axis]: n };
  }
  const next: Record<string, number> = { x: 0, y: 0, z: 0 };
  next[axis] = n;
  return next;
}

/** A pinned ref resolved against its node's fields and values. */
export interface ExposedField {
  /** What the row shows: the field itself, or for an axis a number field named "Position Y". */
  field: ParamFieldDef;
  /** The param the node stores: the vector's id for an axis. Its "wired" state and keyframe status go by it. */
  baseId: string;
  axis?: Axis;
  value: unknown;
  /** The new value for the row's control → the value the node stores (the whole vector, for an axis). */
  toStored: (v: unknown, base?: unknown) => unknown;
}

export function resolveExposedField(
  fields: readonly ParamFieldDef[],
  values: Record<string, unknown>,
  paramId: string,
): ExposedField | null {
  const whole = fields.find((f) => f.id === paramId);
  if (whole) return { field: whole, baseId: paramId, value: values[paramId], toStored: (v) => v };
  const split = splitComponentId(paramId);
  if (!split) return null;
  const vector = fields.find((f) => f.id === split.baseId);
  if (!vector || vector.kind !== "vector") return null;
  const { axis, baseId } = split;
  const field: ParamFieldDef = {
    id: paramId,
    // "Bg Image Offset (fallback)" → "Bg Image Offset Y": the axis reads as part of the name, not of the aside.
    label: `${vector.label.replace(/\s*[(—].*$/, "") || vector.label} ${axis.toUpperCase()}`,
    kind: "number",
    step: vector.step,
    degrees: vector.degrees,
    group: vector.group,
  };
  return {
    field,
    baseId,
    axis,
    value: readComponent(values[baseId], axis),
    // `base`: the vector to set the axis on when it is fresher than the rendered one (MIDI turning two axes at once).
    toStored: (v, base) => withComponent(base ?? values[baseId], axis, Number(v) || 0),
  };
}
