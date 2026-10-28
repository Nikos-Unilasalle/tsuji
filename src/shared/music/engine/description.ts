/**
 * What the graph hands the music engine: plain, serialisable data (it crosses to the AudioWorklet by postMessage).
 * The graph describes, the engine plays — see docs/music-nodes-mvp.md.
 */
import type { FmPatch } from "../dsp/fm";
import type { Sequence } from "../seq/sequencer";

export interface TrackDescription {
  /** Stable across frames: the engine keeps a track's voices (and their ringing tails) for as long as its id lives. */
  id: string;
  kind: "fm";
  /** Polyphony, 1–16. */
  voices: number;
  patch: FmPatch;
  seq: Sequence;
  level: number;
  pan: number;
  mute: boolean;
}

export interface MusicDescription {
  tracks: TrackDescription[];
  master: number;
}

export const EMPTY_DESCRIPTION: MusicDescription = { tracks: [], master: 1 };
