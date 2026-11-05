/**
 * The Mixing Console's automation: a move written while the song plays becomes keyframes on the voice's param (the
 * graph's own keyframes, so the timeline shows them, an export plays them and an undo takes them back), and a param
 * with keyframes is read back from them — the console's faders then move on their own.
 *
 * Writing is "touch": while a control is held, each frame the playhead reaches overwrites what was there since the
 * frame before; let go, and the automation that was there takes over again. A straight stretch keeps only its ends.
 */
import type { Keyframe, KeyframeStore } from "../../graph/types";
import type { StripParam } from "./strips";

/** What a strip can automate (solo is a mixing aid, not part of the song). */
export const AUTOMATABLE: readonly StripParam[] = ["level", "pan", "delaySend", "reverbSend", "mute"];

export function isAutomated(store: KeyframeStore | undefined, nodeId: string, param: string): boolean {
  return (store?.[nodeId]?.[param]?.length ?? 0) > 0;
}

export interface AutomationWrite {
  nodeId: string;
  param: string;
  frame: number;
  value: unknown;
  /** The frame this gesture last wrote, or null for its first write. */
  since: number | null;
  /** The param's value before the gesture: the past keeps it. */
  before: unknown;
}

/** How far off the line through its neighbours a key may be and still be dropped. */
const THIN = 1e-3;

export function writeAutomation(store: KeyframeStore | undefined, w: AutomationWrite): KeyframeStore {
  const frame = Math.max(0, Math.round(w.frame));
  // A gesture that jumped back (a loop, a seek) starts a new stretch where it landed.
  const since = w.since !== null && w.since <= frame ? w.since : null;
  let list: Keyframe[] = [...(store?.[w.nodeId]?.[w.param] ?? [])];
  if (since === null) {
    // The first key: the song before the gesture keeps the value it had.
    if (list.length === 0 && frame > 0) list.push({ frame: 0, value: w.before });
    if (frame > 0 && !list.some((k) => k.frame === frame - 1)) list.push({ frame: frame - 1, value: w.before });
    list = list.filter((k) => k.frame !== frame);
  } else {
    list = list.filter((k) => k.frame !== frame && (k.frame <= since || k.frame > frame));
  }
  list.push({ frame, value: w.value });
  list.sort((a, b) => a.frame - b.frame);
  // Thin the stretch: the key written last time goes if it lies on the line from the one before it to this one.
  if (since !== null && since !== frame) {
    const i = list.findIndex((k) => k.frame === since);
    if (i > 0 && list[i + 1]?.frame === frame) {
      const [a, b, c] = [list[i - 1], list[i], list[i + 1]];
      if (typeof a.value === "number" && typeof b.value === "number" && typeof c.value === "number") {
        const t = (b.frame - a.frame) / (c.frame - a.frame);
        if (Math.abs(a.value + (c.value - a.value) * t - b.value) < THIN) list.splice(i, 1);
      } else if (a.value === b.value && b.value === c.value) list.splice(i, 1);
    }
  }
  return { ...store, [w.nodeId]: { ...store?.[w.nodeId], [w.param]: list } };
}

/** Takes a voice's console automation away (its other keyframes stay). */
export function clearAutomation(store: KeyframeStore | undefined, nodeId: string, params: readonly string[] = AUTOMATABLE): KeyframeStore {
  const own = store?.[nodeId];
  if (!own) return store ?? {};
  const rest = Object.fromEntries(Object.entries(own).filter(([k]) => !params.includes(k)));
  const next = { ...store };
  if (Object.keys(rest).length === 0) delete next[nodeId];
  else next[nodeId] = rest;
  return next;
}
