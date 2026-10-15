import { describe, it, expect } from "vitest";
import { bipedStyle, idleSwayOffset } from "./bipedStyle";

describe("bipedStyle", () => {
  it("is exactly the node's own walk at 0.5", () => {
    const s = bipedStyle(0.5);
    for (const [key, value] of Object.entries(s)) {
      if (key === "armLift") expect(value).toBe(0);
      else if (key === "idleSway") expect(value).toBe(0);
      else expect(value).toBe(key === "urgency" ? 2.4 : 1);
    }
  });

  it("stands still with loose arms at 0 and runs at 1", () => {
    const idle = bipedStyle(0);
    expect(idle.armSwing).toBe(0);
    expect(idle.pelvisBob).toBe(0);
    expect(idle.idleSway).toBe(1);
    expect(idle.stepRadius).toBeGreaterThan(1);
    const run = bipedStyle(1);
    expect(run.armSwing).toBeGreaterThan(1);
    expect(run.stepDuration).toBeLessThan(1);
    expect(run.stepRadius).toBeGreaterThan(1);
    expect(run.urgency).toBeLessThan(2.4);
    expect(run.lean).toBeGreaterThan(1);
  });

  it("moves smoothly between the three and clamps out of range", () => {
    let last = bipedStyle(0).stepDuration;
    for (let i = 1; i <= 20; i++) {
      const d = bipedStyle(i / 20).stepDuration;
      expect(d).toBeLessThanOrEqual(last + 1e-9);
      last = d;
    }
    expect(bipedStyle(-3)).toEqual(bipedStyle(0));
    expect(bipedStyle(9)).toEqual(bipedStyle(1));
    expect(bipedStyle(NaN)).toEqual(bipedStyle(0.5));
  });

  it("sways the two hands out of phase", () => {
    expect(idleSwayOffset(0, 0, 1)).toBeCloseTo(0, 6);
    expect(idleSwayOffset(0.7, 0, 1)).not.toBeCloseTo(idleSwayOffset(0.7, 1, 1), 3);
  });
});
