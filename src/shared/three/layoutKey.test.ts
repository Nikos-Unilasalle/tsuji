import { describe, it, expect } from "vitest";
import { layoutKey } from "./layoutKey";

const ev = (key: string, keyCode: number) => ({ key, keyCode }) as KeyboardEvent;

describe("layoutKey", () => {
  it("returns plain letters and named keys as-is, lower-cased", () => {
    expect(layoutKey(ev("Z", 90))).toBe("z");
    expect(layoutKey(ev("Escape", 27))).toBe("escape");
  });

  it("recovers the letter macOS Option composed into another character", () => {
    expect(layoutKey(ev("Ω", 90))).toBe("z"); // Option+Z, QWERTY
    expect(layoutKey(ev("Â", 90))).toBe("z"); // Option+Z, AZERTY
    expect(layoutKey(ev("å", 65))).toBe("a"); // Option+A
  });

  it("leaves non-letter characters alone", () => {
    expect(layoutKey(ev("&", 49))).toBe("&");
  });
});
