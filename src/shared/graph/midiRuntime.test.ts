import { describe, expect, it } from "vitest";
import { decodeMidi } from "./midiRuntime";

describe("decodeMidi", () => {
  it("reads note on and off, with their channel", () => {
    expect(decodeMidi([0x90, 60, 127], "k", 12)).toEqual({ type: "noteon", channel: 0, note: 60, velocity: 1, port: "k", time: 12 });
    expect(decodeMidi([0x89, 36, 40])).toEqual({ type: "noteoff", channel: 9, note: 36, port: "", time: 0 });
  });

  it("takes a note on at velocity 0 for a note off", () => {
    expect(decodeMidi([0x90, 60, 0])).toEqual({ type: "noteoff", channel: 0, note: 60, port: "", time: 0 });
  });

  it("reads control changes and pitch bend", () => {
    expect(decodeMidi([0xb2, 74, 100])).toEqual({ type: "cc", channel: 2, controller: 74, value: 100, port: "", time: 0 });
    expect(decodeMidi([0xe0, 0, 64])).toMatchObject({ type: "pitchbend", value: 0 });
    expect(decodeMidi([0xe0, 127, 127])).toMatchObject({ value: 1 });
    expect(decodeMidi([0xe0, 0, 0])).toMatchObject({ value: -1 });
  });

  it("ignores what nothing reads, and short messages", () => {
    expect(decodeMidi([0xf8])).toBe(null);
    expect(decodeMidi([0xc0, 5])).toBe(null);
    expect(decodeMidi([0x90, 60])).toBe(null);
  });
});
