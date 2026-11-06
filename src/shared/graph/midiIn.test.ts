import { describe, expect, it } from "vitest";
import { decodeMidi, dispatchMidi, midiCount, readMidiSince, type MidiEvent } from "./midiRuntime";
import { emptyMidiIn, stepMidiIn, type MidiInFilter } from "./midiIn";
import { MIDI_IN_NODE } from "./nodes/input";

const ev = (bytes: number[], port = "MiniLab"): MidiEvent => decodeMidi(bytes, port)!;
const all: MidiInFilter = { port: "", channel: 0, cc: 74, ccMode: "abs" };

describe("stepMidiIn", () => {
  it("holds the keys down, remembers the last struck, counts the strikes", () => {
    const s = emptyMidiIn();
    expect(stepMidiIn(s, [ev([0x90, 60, 100]), ev([0x90, 64, 127]), ev([0x80, 60, 0])], all)).toBe(2);
    expect([...s.held.keys()]).toEqual([64]);
    expect(s.note).toBe(64);
    expect(s.velocity).toBe(1);
    expect(stepMidiIn(s, [ev([0x80, 64, 0])], all)).toBe(0);
    expect(s.held.size).toBe(0);
    expect(s.note).toBe(64);
  });

  it("a note struck and let go between two frames is still a strike", () => {
    const s = emptyMidiIn();
    expect(stepMidiIn(s, [ev([0x90, 60, 100]), ev([0x90, 60, 0])], all)).toBe(1);
    expect(s.held.size).toBe(0);
  });

  it("filters by channel and input", () => {
    const s = emptyMidiIn();
    expect(stepMidiIn(s, [ev([0x91, 60, 100])], { ...all, channel: 1 })).toBe(0);
    expect(stepMidiIn(s, [ev([0x91, 60, 100])], { ...all, channel: 2 })).toBe(1);
    expect(stepMidiIn(s, [ev([0x90, 62, 100], "Keystep")], { ...all, port: "minilab" })).toBe(0);
    expect(stepMidiIn(s, [ev([0x90, 62, 100], "Arturia MINILAB")], { ...all, port: "minilab" })).toBe(1);
  });

  it("wheels, and the chosen CC: a position, or an encoder's steps", () => {
    const s = emptyMidiIn();
    stepMidiIn(s, [ev([0xe0, 127, 127]), ev([0xb0, 1, 127]), ev([0xb0, 74, 127])], all);
    expect(s.pitchBend).toBe(1);
    expect(s.modWheel).toBe(1);
    expect(s.cc).toBe(1);
    const r = emptyMidiIn();
    const rel = { ...all, ccMode: "rel64" as const };
    stepMidiIn(r, [64, 65, 64, 65, 64, 65].map((v) => ev([0xb0, 74, v])), rel);
    expect(r.cc).toBeCloseTo(3 / 127);
    stepMidiIn(r, [ev([0xb0, 74, 0])], rel);
    expect(r.cc).toBe(0);
  });

  it("All Notes Off lets go of everything", () => {
    const s = emptyMidiIn();
    stepMidiIn(s, [ev([0x90, 60, 100]), ev([0x90, 67, 100]), ev([0xb0, 123, 0])], all);
    expect(s.held.size).toBe(0);
  });
});

describe("the log", () => {
  it("each reader takes what came since its last read", () => {
    const from = midiCount();
    dispatchMidi([0x90, 60, 100], "k", 1);
    dispatchMidi([0x80, 60, 0], "k", 2);
    const read = readMidiSince(from);
    expect(read.events.map((e) => e.type)).toEqual(["noteon", "noteoff"]);
    expect(read.missed).toBe(false);
    expect(readMidiSince(read.next).events).toEqual([]);
  });

  it("a reader too far behind is told it missed some", () => {
    const from = midiCount();
    for (let i = 0; i < 1100; i++) dispatchMidi([0xb0, 74, i % 128]);
    const read = readMidiSince(from);
    expect(read.missed).toBe(true);
    expect(read.events.length).toBe(1024);
  });
});

describe("MIDI In node", () => {
  const evaluate = (id: string, params = {}) =>
    MIDI_IN_NODE.evaluate!({}, { ...MIDI_IN_NODE.defaultParams, ...params }, { nodeId: id } as never) as Record<string, unknown>;

  it("starts from now, then fires Trigger once per frame with a strike", () => {
    dispatchMidi([0x90, 48, 100]);
    expect(evaluate("m1").gate).toBe(0);
    dispatchMidi([0x90, 60, 127]);
    dispatchMidi([0x90, 67, 64]);
    const a = evaluate("m1");
    expect(a.trigger).toBe(1);
    expect(a.gate).toBe(1);
    expect(a.notes).toEqual([60, 67]);
    expect(a.note).toBe(67);
    const b = evaluate("m1");
    expect(b.trigger).toBe(0);
    expect(b.gate).toBe(1);
  });
});
