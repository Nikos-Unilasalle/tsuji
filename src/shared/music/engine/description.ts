/**
 * What the graph hands the music engine: plain, serialisable data (it crosses to the AudioWorklet by postMessage).
 * The graph describes, the engine plays — see docs/music-nodes-mvp.md.
 */
import type { DrumSettings } from "../dsp/drums";
import type { FmPatch } from "../dsp/fm";
import type { Sequence } from "../seq/sequencer";

interface TrackBase {
  /** Stable across frames: the engine keeps a track's voices (and their ringing tails) for as long as its id lives. */
  id: string;
  seq: Sequence;
  level: number;
  pan: number;
  mute: boolean;
}

export interface FmTrackDescription extends TrackBase {
  kind: "fm";
  /** Polyphony, 1–16. */
  voices: number;
  patch: FmPatch;
}

export interface DrumTrackDescription extends TrackBase {
  kind: "drums";
  drums: DrumSettings;
}

export type TrackDescription = FmTrackDescription | DrumTrackDescription;

export interface MusicDescription {
  tracks: TrackDescription[];
  master: number;
}

export const EMPTY_DESCRIPTION: MusicDescription = { tracks: [], master: 1 };

/**
 * What flows on a `music` socket: a clock (Clock → Pattern), a sequence (Pattern → Arp → a voice), or a track
 * (a voice → Music Out). One socket type, three shapes; each node reads the one it wants and ignores the others.
 */
export type MusicValue =
  | { kind: "clock"; clock: Sequence["clock"] }
  | { kind: "sequence"; seq: Sequence }
  | TrackDescription;

export function isTrack(v: unknown): v is TrackDescription {
  const k = (v as TrackDescription | null)?.kind;
  return typeof v === "object" && v !== null && (k === "fm" || k === "drums") && typeof (v as TrackDescription).id === "string";
}

/** The sequence a music value carries — a sequence, or a track's. */
export function sequenceOf(v: unknown): Sequence | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as MusicValue;
  if (m.kind === "sequence") return m.seq;
  if (isTrack(m)) return m.seq;
  return null;
}

export function clockOf(v: unknown): Sequence["clock"] | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as MusicValue;
  if (m.kind === "clock") return m.clock;
  return sequenceOf(m)?.clock ?? null;
}
