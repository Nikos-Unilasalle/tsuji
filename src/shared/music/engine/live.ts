/**
 * The MIDI keyboard played live on the voices that have MIDI Play on: which note each key sounds on which track, and
 * when it is let go. Pure — the bridge posts what it returns to the engines.
 *
 * - A melodic voice plays the key, with the voice's transpose (its sequence has it already; a key does not).
 * - A drum kit plays the sound the key or pad stands for (midiEntry's map: the MiniLab's pads, GM drum notes).
 * - The sustain pedal (CC 64) holds what is let go while it is down, until it comes up.
 * - All Notes Off / All Sound Off (CC 123, 120) let go of everything.
 * A key let go sounds off the note it struck, even when the transpose changed in between.
 */
import { DRUM_NOTES } from "../dsp/drums";
import { drumForMidi } from "../seq/midiEntry";
import type { MidiEvent } from "../../graph/midiRuntime";
import type { TrackDescription } from "./description";

export interface LiveTrack {
  id: string;
  kind: TrackDescription["kind"];
  transpose: number;
}

export interface LiveNote {
  track: string;
  note: number;
  /** 0: let go. */
  velocity: number;
}

/** The tracks of a description that are played live. */
export function liveTracksOf(tracks: readonly TrackDescription[]): LiveTrack[] {
  return tracks.filter((t) => t.live).map((t) => ({ id: t.id, kind: t.kind, transpose: t.live!.transpose }));
}

export class LiveRouter {
  /** Per key (port, channel, note) and track: the note it sounds. */
  private sounding = new Map<string, Map<string, number>>();
  /** Keys let go while the pedal is down. */
  private sustained = new Set<string>();
  private pedal = false;

  route(e: MidiEvent, tracks: readonly LiveTrack[]): LiveNote[] {
    if (e.type === "cc") {
      if (e.controller === 64) {
        this.pedal = e.value >= 64;
        if (this.pedal) return [];
        const out: LiveNote[] = [];
        for (const key of this.sustained) out.push(...this.release(key));
        this.sustained.clear();
        return out;
      }
      if (e.controller === 123 || e.controller === 120) {
        const out: LiveNote[] = [];
        for (const key of [...this.sounding.keys()]) out.push(...this.release(key));
        this.sustained.clear();
        return out;
      }
      return [];
    }
    if (e.type !== "noteon" && e.type !== "noteoff") return [];
    const key = `${e.port}|${e.channel}|${e.note}`;
    if (e.type === "noteoff") {
      if (this.pedal && this.sounding.has(key)) {
        this.sustained.add(key);
        return [];
      }
      return this.release(key);
    }
    // Struck again while still sounding (held by the pedal): let go first, so it strikes fresh.
    const out = this.release(key);
    this.sustained.delete(key);
    const sounds = new Map<string, number>();
    for (const t of tracks) {
      let note: number;
      if (t.kind === "drums") {
        const drum = drumForMidi(e.channel, e.note);
        if (!drum || drum === "rest") continue;
        note = DRUM_NOTES[drum];
      } else {
        note = e.note + t.transpose;
        if (note < 0 || note > 127) continue;
      }
      sounds.set(t.id, note);
      out.push({ track: t.id, note, velocity: Math.max(0.01, e.velocity) });
    }
    if (sounds.size > 0) this.sounding.set(key, sounds);
    return out;
  }

  private release(key: string): LiveNote[] {
    const sounds = this.sounding.get(key);
    if (!sounds) return [];
    this.sounding.delete(key);
    return [...sounds].map(([track, note]) => ({ track, note, velocity: 0 }));
  }
}
