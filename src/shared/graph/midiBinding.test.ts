import { describe, expect, it } from "vitest";
import { applyCc, bindingMatches, bindingStep, defaultStep, detectMode, learnBinding, relativeDelta, type BindableField, type MidiBinding } from "./midiBinding";

const num: BindableField = { id: "x", label: "X", kind: "number" };
const bool: BindableField = { id: "b", label: "B", kind: "boolean" };
const sel: BindableField = { id: "s", label: "S", kind: "select", options: ["a", "b", "c", "d"] };
const bind = (over: Partial<MidiBinding> = {}): MidiBinding => ({ channel: 0, cc: 74, mode: "rel64", step: 0.1, ...over });

describe("relativeDelta", () => {
  it("decodes the three encoder codings", () => {
    expect([63, 64, 65, 70].map((v) => relativeDelta(v, "rel64"))).toEqual([-1, 0, 1, 6]);
    expect([1, 3, 127, 125].map((v) => relativeDelta(v, "rel2c"))).toEqual([1, 3, -1, -3]);
    expect([1, 3, 65, 67].map((v) => relativeDelta(v, "relsign"))).toEqual([1, 3, -1, -3]);
    expect(relativeDelta(100, "abs")).toBe(0);
  });
});

describe("defaultStep", () => {
  it("takes the field's step, a degree for an angle, a percent for a fraction", () => {
    expect(defaultStep({ ...num, step: 0.5 }, 3)).toBe(0.5);
    expect(defaultStep({ ...num, degrees: true }, 0)).toBeCloseTo(Math.PI / 180);
    expect(defaultStep({ ...num, percent: true }, 0.3)).toBe(0.01);
  });

  it("else a hundredth of the value's order of magnitude", () => {
    expect(defaultStep(num, 0)).toBe(0.01);
    expect(defaultStep(num, 0.95)).toBe(0.01);
    expect(defaultStep(num, 5)).toBe(0.01);
    expect(defaultStep(num, 120)).toBe(1);
    expect(defaultStep(num, -3000)).toBe(10);
  });
});

describe("learnBinding", () => {
  it("a number gets a step and is endless, a boolean toggles", () => {
    expect(learnBinding(num, 2, 10, 5)).toEqual({ channel: 2, cc: 10, mode: "rel64", step: 0.01 });
    expect(learnBinding(bool, 0, 20, false)).toEqual({ channel: 0, cc: 20, mode: "toggle" });
  });
});

describe("applyCc", () => {
  it("each notch adds the step one way and takes it off the other, from where the value is", () => {
    expect(applyCc(num, bind(), 65, 3)).toBe(3.1);
    expect(applyCc(num, bind(), 63, 3)).toBe(2.9);
    expect(applyCc(num, bind(), 67, 3)).toBe(3.3);
    expect(applyCc(num, bind({ mode: "rel2c" }), 127, 3)).toBe(2.9);
    expect(applyCc(num, bind({ mode: "relsign" }), 65, 3)).toBe(2.9);
    expect(applyCc(num, bind(), 64, 3)).toBe(undefined);
  });

  it("has no ends", () => {
    expect(applyCc(num, bind(), 65, 1000)).toBe(1000.1);
    expect(applyCc(num, bind(), 63, -1000)).toBe(-1000.1);
  });

  it("adds without float noise", () => {
    let v: unknown = 0;
    for (let i = 0; i < 3; i++) v = applyCc(num, bind(), 65, v);
    expect(v).toBe(0.3);
  });

  it("reads a binding from before — absolute, with a range — as 64±, at the default step", () => {
    const old = bind({ mode: "abs", step: undefined, min: 0, max: 12.7 });
    expect(bindingStep(num, old, 1)).toBe(0.01);
    expect(applyCc(num, old, 65, 1)).toBe(1.01);
  });

  it("a toggle flips on the press only", () => {
    const b = bind({ mode: "toggle" });
    expect(applyCc(bool, b, 127, false, 0)).toBe(true);
    expect(applyCc(bool, b, 0, true, 127)).toBe(undefined);
    expect(applyCc(bool, b, 127, true, undefined)).toBe(false);
  });

  it("an absolute button on a boolean follows it", () => {
    expect(applyCc(bool, bind({ mode: "abs" }), 127, false)).toBe(true);
    expect(applyCc(bool, bind({ mode: "abs" }), 0, true)).toBe(false);
  });

  it("a select steps through its options, stopping at the ends", () => {
    expect(applyCc(sel, bind(), 66, "b")).toBe("c");
    expect(applyCc(sel, bind(), 60, "b")).toBe("a");
    expect(applyCc(sel, bind(), 60, "a")).toBe(undefined);
    expect(applyCc(sel, bind(), 66, "d")).toBe(undefined);
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
    expect(seen).toEqual([5, 5.01, 5.01, 5.02, 5.02, 5.03, 5.03, 5.04]);
  });
});
