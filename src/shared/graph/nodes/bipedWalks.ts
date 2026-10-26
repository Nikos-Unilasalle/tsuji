import { GaitStyle, NATURAL_STYLE } from "../ik/gaitModel";
import { GAIT_PRESETS, GaitMode, GaitPresetKey, presetSpeed, presetStyle } from "../ik/gaitPresets";
import type { RouteMark } from "../ik/route";

/**
 * Walks saved on a Biped Motion — a tuned style kept under a name, with the
 * speed and gait it was tuned at — and the walk a route takes over time as
 * its Walk / Run marks hand from one walk to the next.
 *
 * A mark names its walk by "" (the node's own), a gait preset key, or
 * "mine:<id>" for a saved one. Saved walks live in the node's `myWalks` param,
 * so they travel with the project.
 */

export interface SavedWalk {
  id: string;
  name: string;
  style: GaitStyle;
  /** m/s. */
  speed: number;
  gait: GaitMode;
}

export function readSavedWalks(value: unknown): SavedWalk[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((w): w is Record<string, unknown> => Boolean(w) && typeof w === "object" && typeof (w as { id?: unknown }).id === "string")
    .map((w) => {
      const style = { ...NATURAL_STYLE };
      const saved = (w.style ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(NATURAL_STYLE) as (keyof GaitStyle)[]) {
        const n = Number(saved[key]);
        if (Number.isFinite(n)) style[key] = n;
      }
      return {
        id: String(w.id),
        name: typeof w.name === "string" && w.name ? w.name : "My walk",
        style,
        speed: Number(w.speed) > 0 ? Number(w.speed) : 1.3,
        gait: w.gait === "walk" || w.gait === "run" ? w.gait : "auto",
      };
    });
}

/** The params that make the node walk a saved walk (one undo step). */
export function savedWalkParams(walk: SavedWalk): Record<string, unknown> {
  return { ...walk.style, speed: walk.speed, gait: walk.gait, preset: `mine:${walk.id}` };
}

export function walkLabel(id: string, saved: SavedWalk[]): string {
  if (!id) return "";
  if (id.startsWith("mine:")) return saved.find((w) => w.id === id.slice(5))?.name ?? "deleted walk";
  return id in GAIT_PRESETS ? GAIT_PRESETS[id as GaitPresetKey].label : id;
}

/** A walk by id: its style and speed (m/s) for a body of this hip height (m); null for the node's own. */
export function resolveWalk(id: string | undefined, saved: SavedWalk[], hipHeight: number): { style: GaitStyle; speed: number } | null {
  if (!id) return null;
  if (id.startsWith("mine:")) {
    const walk = saved.find((w) => w.id === id.slice(5));
    return walk ? { style: walk.style, speed: walk.speed } : null;
  }
  if (id in GAIT_PRESETS) return { style: presetStyle(id as GaitPresetKey), speed: presetSpeed(id as GaitPresetKey, hipHeight) };
  return null;
}

/** Seconds a handover from one walk to the next takes — about a stride. */
export const HANDOVER = 1;

const smooth = (x: number) => {
  const u = Math.max(0, Math.min(1, x));
  return u * u * (3 - 2 * u);
};

export function lerpStyle(a: GaitStyle, b: GaitStyle, t: number): GaitStyle {
  const out = { ...a };
  for (const key of Object.keys(a) as (keyof GaitStyle)[]) out[key] = a[key] + (b[key] - a[key]) * t;
  return out;
}

/**
 * The route's walk at any time: the node's own until the first Walk / Run mark
 * naming one, then each mark's from the moment it is reached, blended over
 * HANDOVER seconds. `key` changes exactly when the style does.
 */
export function routeWalkSchedule(marks: RouteMark[], markTimes: number[], own: GaitStyle, saved: SavedWalk[], hipHeight: number) {
  const changes = marks
    .map((m, i) => ({ m, t: markTimes[i] ?? 0 }))
    .filter(({ m }) => m.kind === "walk" || m.kind === "run")
    .sort((a, b) => a.t - b.t)
    .map(({ m, t }) => ({ t, style: resolveWalk(m.style, saved, hipHeight)?.style ?? own }));
  return (time: number): { style: GaitStyle; key: string } => {
    let k = -1;
    for (let i = 0; i < changes.length; i++) if (changes[i].t <= time) k = i;
    if (k < 0) return { style: own, key: "own" };
    const w = smooth((time - changes[k].t) / HANDOVER);
    if (w >= 1) return { style: changes[k].style, key: `${k}` };
    return { style: lerpStyle(k > 0 ? changes[k - 1].style : own, changes[k].style, w), key: `${k}:${w.toFixed(6)}` };
  };
}

/** Marks with their speed (m/s) filled in from their walk where they leave it at 0. */
export function marksWithWalkSpeeds(marks: RouteMark[], saved: SavedWalk[], hipHeight: number): RouteMark[] {
  return marks.map((m) => {
    if ((m.kind !== "walk" && m.kind !== "run") || (Number(m.speed) || 0) > 0) return m;
    const walk = resolveWalk(m.style, saved, hipHeight);
    return walk ? { ...m, speed: walk.speed } : m;
  });
}
