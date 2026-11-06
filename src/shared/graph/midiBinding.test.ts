import { describe, expect, it } from "vitest";
import { applyCc, bindingMatches, defaultRange, detectMode, learnBinding, relativeDelta, type BindableField, type MidiBinding } from "./midiBinding";

const num: BindableField = { id: "x", label: "X", kind: "number" };
const bool: BindableField = { id: "b", label: "B", kind: "boolean" };
const sel: BindableField = { id: "s", label: "S", kind: "select", options: ["a", "b", "c", "d"] };
const bind = (over: Partial<MidiBinding> = {}): MidiBinding => ({ channel: 0, cc: 74, mode: "abs", min: 0, max: 10, ...over });

describe("relativeDelta", () => {
  it("decodes the three encoder codings", () => {
    expect([63, 64, 65, 70].map((v) => relativeDelta(v, "rel64"))).toEqual([-1, 0, 1, 6]);
    expect([1, 3, 127, 125].map((v) => relativeDelta(v, "rel2c"))).toEqual([1, 3, -1, -3]);
    expect([1, 3, 65, 67].map((v) => relativeDelta(v, "relsign"))).toEqual([1, 3, -1, -3]);
    expect(relativeDelta(100, "abs")).toBe(0);
  });
});

describe("defaultRange", () => {
  it("takes a fraction for a percent, ±180° for an angle", () => {
    expect(defaultRange({ ...num, percent: true }, 0.3)).toEqual([0, 1]);
    expect(defaultRange({ ...num, degrees: true }, 0)).toEqual([-Math.PI, Math.PI]);
  });

  it("else rounds up past twice the value, both ways when negative", () => {
    expect(defaultRange(num, 0.4)).toEqual([0, 1]);
    expect(defaultRange(num, 5)).toEqual([0, 10]);
    expect(defaultRange(num, 120)).toEqual([0, 500]);
    expect(defaultRange(num, -3)).toEqual([-10, 10]);
  });
});

describe("learnBinding", () => {
  it("a number gets a range, a boolean toggles", () => {
    expect(learnBinding(num, 2, 10, 5)).toEqual({ channel: 2, cc: 10, mode: "abs", min: 0, max: 10 });
    expect(learnBinding(bool, 0, 20, false)).toEqual({ channel: 0, cc: 20, mode: "toggle" });
  });
});

describe("applyCc", () => {
  it("an absolute knob puts a number across its range", () => {
    expect(applyCc(num, bind(), 0, 3)).toBe(0);
    expect(applyCc(num, bind(), 127, 3)).toBe(10);
    expect(applyCc(num, bind(), 64, 3)).toBe(5.04);
    expect(applyCc({ ...num, step: 1 }, bind(), 64, 3)).toBe(5);
  });

  it("an encoder moves a number from where it is, a 127th of the range a step", () => {
    expect(applyCc(num, bind({ mode: "rel64" }), 65, 3)).toBe(3.08);
    expect(applyCc(num, bind({ mode: "rel2c" }), 127, 3)).toBe(2.92);
    expect(applyCc(num, bind({ mode: "rel64" }), 64, 3)).toBe(undefined);
  });

  it("an encoder stops at the range's ends, but leaves a value already past one alone", () => {
    expect(applyCc(num, bind({ mode: "rel64" }), 127, 9.9)).toBe(10);
    expect(applyCc(num, bind({ mode: "rel64" }), 65, 50)).toBe(50);
    expect(applyCc(num, bind({ mode: "rel64" }), 63, 50)).toBe(49.92);
  });

  it("a toggle flips on the press only", () => {
    const b = bind({ mode: "toggle" });
    expect(applyCc(bool, b, 127, false, 0)).toBe(true);
    expect(applyCc(bool, b, 0, true, 127)).toBe(undefined);
    expect(applyCc(bool, b, 127, true, undefined)).toBe(false);
  });

  it("an absolute button on a boolean follows it", () => {
    expect(applyCc(bool, bind(), 127, false)).toBe(true);
    expect(applyCc(bool, bind(), 0, true)).toBe(false);
  });

  it("a select picks across its options, or steps through them", () => {
    expect(applyCc(sel, bind(), 0, "c")).toBe("a");
    expect(applyCc(sel, bind(), 127, "a")).toBe("d");
    expect(applyCc(sel, bind(), 127, "d")).toBe(undefined);
    expect(applyCc(sel, bind({ mode: "rel64" }), 66, "b")).toBe("c");
    expect(applyCc(sel, bind({ mode: "rel64" }), 60, "a")).toBe(undefined);
  });
});

describe("ports", () => {
  it("a binding learned on one input ignores the same CC from another", () => {
    const b = learnBinding(num, 0, 74, 5, "Minilab3 MIDI");
    expect(b.port).toBe("Minilab3 MIDI");
    expect(bindingMatches(b, "Minilab3 MIDI", 0, 74)).toBe(true);
    expect(bindingMatches(b, "Minilab3 MCU/HUI", 0, 74)).toBe(false);
    expect(bindingMatches(b, "Minilab3 MIDI", 1, 74)).toBe(false);
  });

  it("a binding without a port (saved before) listens to every input", () => {
    expect(bindingMatches(bind(), "anything", 0, 74)).toBe(true);
  });
});

describe("detectMode", () => {
  it("a knob with ends moves through positions", () => {
    expect(detectMode([40, 41, 42, 44, 45, 47])).toBe("abs");
    expect(detectMode([90, 88, 87, 85])).toBe("abs");
    // Through the middle, too: positions, not steps around 64.
    expect(detectMode([58, 60, 62, 64, 66, 68, 70])).toBe("abs");
  });

  it("an encoder repeats its step: 64±", () => {
    expect(detectMode([65, 65, 65, 66, 65])).toBe("rel64");
    expect(detectMode([63, 63, 62, 63])).toBe("rel64");
    // The Arturia MiniLab: a rest value (64) between each step, never twice the same in a row.
    expect(detectMode([64, 65, 64, 65, 64, 65, 64, 65, 64, 65])).toBe("rel64");
    expect(detectMode([64, 63, 64, 63, 64])).toBe("rel64");
    // Fast both ways, no repeat: still all around 64.
    expect(detectMode([65, 63, 66, 62, 65])).toBe("rel64");
  });

  it("2's complement and sign bit", () => {
    expect(detectMode([1, 1, 1, 2, 1])).toBe("rel2c");
    expect(detectMode([127, 127, 126, 127])).toBe("rel2c");
    expect(detectMode([1, 1, 65, 65, 65])).toBe("relsign");
  });

  it("too little to tell", () => {
    expect(detectMode([64])).toBe(null);
    expect(detectMode([30, 30, 30])).toBe(null);
  });
});

describe("coarse steps", () => {
  it("an encoder step is at least the field's step, so a coarse field still moves", () => {
    const coarse: BindableField = { ...num, step: 0.05 };
    expect(applyCc(coarse, bind({ mode: "rel64", min: 0, max: 1 }), 65, 0.45)).toBe(0.5);
    expect(applyCc(coarse, bind({ mode: "rel64", min: 0, max: 1 }), 62, 0.45)).toBe(0.35);
  });
});

describe("the MiniLab's encoder, end to end", () => {
  it("64 65 64 65… climbs steadily, never back", () => {
    const sent = [64, 65, 64, 65, 64, 65, 64, 65];
    const b = learnBinding(num, 0, 74, 5, "Arturia MINILAB");
    b.mode = detectMode(sent)!;
    let value: unknown = 5;
    const seen: number[] = [];
    for (const v of sent) {
      value = applyCc(num, b, v, value) ?? value;
      seen.push(value as number);
    }
    expect(b.mode).toBe("rel64");
    expect(seen).toEqual([5, 5.08, 5.08, 5.16, 5.16, 5.24, 5.24, 5.32]);
  });
});
