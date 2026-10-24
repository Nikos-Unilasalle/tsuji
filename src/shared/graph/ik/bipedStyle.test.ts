import { describe, it, expect } from "vitest";
import { idleSwayOffset } from "./bipedStyle";

describe("idleSwayOffset", () => {
  it("sways the two hands out of phase", () => {
    expect(idleSwayOffset(0, 0, 1)).toBeCloseTo(0, 6);
    expect(idleSwayOffset(0.7, 0, 1)).not.toBeCloseTo(idleSwayOffset(0.7, 1, 1), 3);
  });
});
