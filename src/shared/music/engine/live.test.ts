import { describe, expect, it } from "vitest";
import { decodeMidi } from "../../graph/midiRuntime";
import { LiveRouter, liveTracksOf, type LiveTrack } from "./live";
import type { TrackDescription } from "./description";

const ev = (bytes: number[]) => decodeMidi(bytes, "MiniLab")!;
const piano: LiveTrack = { id: "p", kind: "fm", transpose: 12 };
const kit: LiveTrack = { id: "d", kind: "drums", transpose: 0 };

describe("LiveRouter", () => {
  it("a key plays on each live track, transposed, and lets go of the note it struck", () => {
    const r = new LiveRouter();
    expect(r.route(ev([0x90, 60, 127]), [piano])).toEqual([{ track: "p", note: 72, velocity: 1 }]);
    // The transpose changed while the key was held: it still lets go of 72.
    expect(r.route(ev([0x80, 60, 0]), [{ ...piano, transpose: 0 }])).toEqual([{ track: "p", note: 72, velocity: 0 }]);
    expect(r.route(ev([0x80, 60, 0]), [piano])).toEqual([]);
  });

  it("a kit plays the sound a pad or GM note stands for, nothing for the others", () => {
    const r = new LiveRouter();
    expect(r.route(ev([0x99, 36, 127]), [kit])).toEqual([{ track: "d", note: 36, velocity: 1 }]);
    expect(r.route(ev([0x90, 61, 127]), [kit])).toEqual([]);
  });

  it("the sustain pedal holds what is let go until it comes up", () => {
    const r = new LiveRouter();
    r.route(ev([0xb0, 64, 127]), [piano]);
    r.route(ev([0x90, 60, 127]), [piano]);
    expect(r.route(ev([0x80, 60, 0]), [piano])).toEqual([]);
    expect(r.route(ev([0xb0, 64, 0]), [piano])).toEqual([{ track: "p", note: 72, velocity: 0 }]);
  });

  it("a key struck again under the pedal strikes fresh", () => {
    const r = new LiveRouter();
    r.route(ev([0xb0, 64, 127]), [piano]);
    r.route(ev([0x90, 60, 127]), [piano]);
    r.route(ev([0x80, 60, 0]), [piano]);
    expect(r.route(ev([0x90, 60, 127]), [piano])).toEqual([
      { track: "p", note: 72, velocity: 0 },
      { track: "p", note: 72, velocity: 1 },
    ]);
  });

  it("All Notes Off lets go of everything", () => {
    const r = new LiveRouter();
    r.route(ev([0x90, 60, 127]), [piano]);
    r.route(ev([0x90, 64, 127]), [piano]);
    expect(r.route(ev([0xb0, 123, 0]), [piano]).map((n) => n.note).sort()).toEqual([72, 76]);
  });
});

describe("liveTracksOf", () => {
  it("only the tracks with MIDI Play on", () => {
    const base = { seq: { clock: { bpm: 120, swing: 0, stepsPerBeat: 4 }, pattern: { length: 16, steps: [] } }, level: 1, pan: 0, mute: false };
    const tracks = [
      { ...base, id: "a", kind: "drums", drums: { tune: 0, decay: 1 }, live: { transpose: 0 } },
      { ...base, id: "b", kind: "drums", drums: { tune: 0, decay: 1 } },
    ] as TrackDescription[];
    expect(liveTracksOf(tracks)).toEqual([{ id: "a", kind: "drums", transpose: 0 }]);
  });
});
