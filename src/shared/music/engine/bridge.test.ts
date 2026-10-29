import { describe, expect, it } from "vitest";
import { musicEngineFor, releaseMusicEngine } from "./bridge";

describe("music engine registry", () => {
  it("gives a node the same engine every time, and a fresh one after it is released", () => {
    const a = musicEngineFor("out");
    expect(musicEngineFor("out")).toBe(a);
    expect(musicEngineFor("other")).not.toBe(a);
    releaseMusicEngine("out");
    expect(musicEngineFor("out")).not.toBe(a);
    releaseMusicEngine("out");
    releaseMusicEngine("other");
  });

  it("stays silent without Web Audio instead of throwing", () => {
    const e = musicEngineFor("headless");
    expect(e.available).toBe(false);
    expect(() => e.follow(true, 0, 0)).not.toThrow();
    releaseMusicEngine("headless");
  });
});
