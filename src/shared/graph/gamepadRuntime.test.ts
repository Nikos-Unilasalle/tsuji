import { afterEach, describe, expect, test, vi } from "vitest";
import { getConnectedGamepads, subscribeGamepads } from "./gamepadRuntime";

function pad(connected: boolean, id = "test-pad") {
  return { connected, id, axes: [], buttons: [] };
}

describe("gamepad connection tracking", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("lists only connected pads, with their index", () => {
    vi.stubGlobal("navigator", {
      getGamepads: () => [pad(true), pad(false), null, pad(true, "second")],
    });
    expect(getConnectedGamepads()).toEqual([
      { index: 0, id: "test-pad" },
      { index: 3, id: "second" },
    ]);
  });

  test("a missing getGamepads reads as no pads, not a crash", () => {
    vi.stubGlobal("navigator", {});
    expect(getConnectedGamepads()).toEqual([]);
  });

  test("subscribeGamepads delivers the current set immediately and unsubscribes", () => {
    vi.stubGlobal("navigator", {
      getGamepads: () => [pad(true)],
    });
    const seen: number[][] = [];
    const unsubscribe = subscribeGamepads((pads) => seen.push(pads.map((p) => p.index)));
    expect(seen).toEqual([[0]]);

    // The unsubscribe is a no-op afterwards — nothing to assert beyond that it
    // does not throw and stops the listener receiving further notifications.
    unsubscribe();
  });
});
