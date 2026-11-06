import { relativeDelta, type CcMode } from "./midiBinding";
import type { MidiEvent } from "./midiRuntime";

/**
 * What the MIDI In node knows of a controller, kept from frame to frame and moved on by the messages that came in
 * since the last one. Pure, for the tests: the node only reads the log and hands the messages over.
 */
export interface MidiInState {
  /** The keys down, in the order struck, with their velocities. */
  held: Map<number, number>;
  /** The last note struck, held or not (0 before any). */
  note: number;
  velocity: number;
  /** −1…1, 0 at rest. */
  pitchBend: number;
  /** CC 1, 0–1. */
  modWheel: number;
  /** The chosen CC, 0–1: its position, or for an encoder the sum of its steps from 0. */
  cc: number;
}

export function emptyMidiIn(): MidiInState {
  return { held: new Map(), note: 0, velocity: 0, pitchBend: 0, modWheel: 0, cc: 0 };
}

export interface MidiInFilter {
  /** Part of an input's name, any case; empty: every input. */
  port: string;
  /** 1–16; 0: every channel. */
  channel: number;
  /** The CC the `cc` output follows. */
  cc: number;
  ccMode: Exclude<CcMode, "toggle">;
}

export function midiInAccepts(filter: MidiInFilter, e: MidiEvent): boolean {
  if (filter.channel > 0 && e.channel !== filter.channel - 1) return false;
  const port = filter.port.trim().toLowerCase();
  return !port || e.port.toLowerCase().includes(port);
}

/** Moves the state on by the messages that came in; returns how many notes were struck among them. */
export function stepMidiIn(state: MidiInState, events: readonly MidiEvent[], filter: MidiInFilter): number {
  let struck = 0;
  for (const e of events) {
    if (!midiInAccepts(filter, e)) continue;
    switch (e.type) {
      case "noteon":
        // Struck again while held: to the end of the order, as the newest.
        state.held.delete(e.note);
        state.held.set(e.note, e.velocity);
        state.note = e.note;
        state.velocity = e.velocity;
        struck++;
        break;
      case "noteoff":
        state.held.delete(e.note);
        break;
      case "pitchbend":
        state.pitchBend = e.value;
        break;
      case "cc":
        if (e.controller === 1) state.modWheel = e.value / 127;
        if (e.controller === filter.cc) {
          state.cc =
            filter.ccMode === "abs" ? e.value / 127 : Math.max(0, Math.min(1, state.cc + relativeDelta(e.value, filter.ccMode) / 127));
        }
        // All Notes Off / All Sound Off: a panic button lets go of everything.
        if (e.controller === 123 || e.controller === 120) state.held.clear();
        break;
    }
  }
  return struck;
}
