import { describe, expect, it } from "vitest";
import { defaultRange, dragValue, knobFraction, labelRange, linkedVector, storedRange, vectorAxisRange } from "./virtualInterface";

describe("Virtual Interface knobs", () => {
  it("guesses a range from the value", () => {
    expect(defaultRange(0.4)).toEqual([0, 1]);
    expect(defaultRange(3)).toEqual([0, 10]);
    expect(defaultRange(120)).toEqual([0, 500]);
    expect(defaultRange(-3)).toEqual([-10, 10]);
    expect(defaultRange(45, { degrees: true })).toEqual([0, 360]);
    expect(defaultRange(30, { percent: true })).toEqual([0, 100]);
    expect(defaultRange(0, { label: "Transpose (semitones)", step: 1 })).toEqual([-24, 24]);
    expect(defaultRange(1, { label: "Brightness × (scales the modulation)" })).toEqual([0, 2]);
    expect(defaultRange(3, { step: 1 })).toEqual([0, 10]);
  });

  it("places a value on the knob's travel, clamped", () => {
    expect(knobFraction(5, [0, 10])).toBe(0.5);
    expect(knobFraction(-1, [0, 10])).toBe(0);
    expect(knobFraction(20, [0, 10])).toBe(1);
  });

  it("turns a drag into a value: the range in 200 px, fine is ten times slower, snapped, clamped", () => {
    expect(dragValue(0, 100, [0, 1])).toBe(0.5);
    expect(dragValue(0, 100, [0, 1], { fine: true })).toBe(0.05);
    expect(dragValue(0, 33, [0, 10], { step: 1 })).toBe(2);
    expect(dragValue(0.9, 100, [0, 1])).toBe(1);
  });

  it("reads only usable stored ranges", () => {
    expect(storedRange({ "a:b": [0, 5] }, "a:b")).toEqual([0, 5]);
    expect(storedRange({ "a:b": [5, 5] }, "a:b")).toBe(null);
    expect(storedRange(undefined, "a:b")).toBe(null);
  });

  it("reads a range from the label's brackets", () => {
    expect(labelRange("Pan (−1 left, 1 right)")).toEqual([-1, 1]);
    expect(labelRange("Voices (1–16, 1 = mono)")).toEqual([1, 16]);
    expect(labelRange("Transpose (semitones)")).toBe(null);
    expect(labelRange("Chance (50 %)")).toBe(null);
    expect(defaultRange(0, { label: "Pan (−1 left, 1 right)" })).toEqual([-1, 1]);
    // A value outside what the label says: the label was not a range.
    expect(defaultRange(40, { label: "Voices (1–16)" })).toEqual([0, 100]);
  });

  it("moves linked axes by the same amount, a zero axis too", () => {
    expect(linkedVector({ x: 1, y: 0, z: 2 }, "x", 1.5, ["x", "y", "z"])).toEqual({ x: 1.5, y: 0.5, z: 2.5 });
    expect(linkedVector({ x: 1, y: 0, z: 0 }, "y", -1, ["x", "y"])).toEqual({ x: 0, y: -1, z: 0 });
  });

  it("guesses a vector axis's range: a scale from 0, a position either side of 0", () => {
    expect(vectorAxisRange(1, { label: "Scale" })).toEqual([0, 2]);
    expect(vectorAxisRange(0, { label: "Location" })).toEqual([-5, 5]);
    expect(vectorAxisRange(12, { label: "Location" })).toEqual([-50, 50]);
    expect(vectorAxisRange(30, { label: "Rotation (°)", degrees: true })).toEqual([-180, 180]);
  });
});
