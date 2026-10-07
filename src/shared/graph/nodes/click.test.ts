import { afterEach, describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { CLICK_NODE } from "./click";
import { simulatePointerButton, simulatePointerClick } from "../pointerStore";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "click-1" };

afterEach(() => {
  simulatePointerButton(0, false);
  simulatePointerButton(1, false);
  simulatePointerButton(2, false);
});

describe("CLICK_NODE", () => {
  it("detects isDown, the rising edge (pressed) and the falling edge (released)", () => {
    let res = CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, CTX);
    expect(res).toEqual({ isDown: 0, pressed: 0, released: 0 });

    simulatePointerButton(0, true);

    // First frame of the press: isDown and pressed both fire.
    res = CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, CTX);
    expect(res).toEqual({ isDown: 1, pressed: 1, released: 0 });

    // Held: isDown stays, pressed doesn't repeat.
    res = CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, CTX);
    expect(res).toEqual({ isDown: 1, pressed: 0, released: 0 });

    simulatePointerButton(0, false);

    // First frame after release: released fires once.
    res = CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, CTX);
    expect(res).toEqual({ isDown: 0, pressed: 0, released: 1 });

    res = CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, CTX);
    expect(res).toEqual({ isDown: 0, pressed: 0, released: 0 });
  });

  it("tracks left/middle/right independently via the button param", () => {
    simulatePointerButton(2, true); // right button only

    expect(CLICK_NODE.evaluate({}, { button: "left" }, { ...CTX, nodeId: "click-left" }).isDown).toBe(0);
    expect(CLICK_NODE.evaluate({}, { button: "right" }, { ...CTX, nodeId: "click-right" }).isDown).toBe(1);
    expect(CLICK_NODE.evaluate({}, { button: "middle" }, { ...CTX, nodeId: "click-middle" }).isDown).toBe(0);
  });

  it("tracks each node instance's edge state independently", () => {
    simulatePointerButton(0, true);
    expect(CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, { ...CTX, nodeId: "a" }).pressed).toBe(1);
    // A second node reading the same button for the first time also sees pressed=1 — it has its own prev-state.
    expect(CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, { ...CTX, nodeId: "b" }).pressed).toBe(1);
    // Node "a" on its second read no longer sees a rising edge.
    expect(CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, { ...CTX, nodeId: "a" }).pressed).toBe(0);
  });

  it("still reports pressed and released for a click faster than one evaluate cycle", () => {
    // Regression: evaluate() only samples isDown once a frame. A click quick
    // enough to press and release between two reads used to flip the live
    // boolean on and back off with isDown never once observed `true` here —
    // pressed (a level comparison) never fired and the click was silently
    // eaten. Confirmed against the real DOM listeners in the app before this
    // fix, via a genuine mouse click landing with no visible effect.
    //
    // A dedicated node id: downCounts/upCounts are global per button, shared
    // with every other test in this file, so this node's very first read has
    // to happen before its own simulatePointerClick to establish its own
    // baseline — reusing another test's node id would inherit whatever edge
    // that test left mid-air.
    const ctx = { ...CTX, nodeId: "click-fast" };
    let res = CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, ctx);
    expect(res).toEqual({ isDown: 0, pressed: 0, released: 0 });

    simulatePointerClick(0); // down and up, both between reads

    res = CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, ctx);
    expect(res.isDown).toBe(0); // already back up by the time this reads
    expect(res.pressed).toBe(1);
    expect(res.released).toBe(1);

    // Settles — no repeat pulse on the next read.
    res = CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, ctx);
    expect(res).toEqual({ isDown: 0, pressed: 0, released: 0 });
  });

  it("every viewport sees the press once, not only the first to evaluate", () => {
    const editor: EvalContext = { ...CTX, nodeId: "click-views", sessionId: "viewport-0" };
    const output: EvalContext = { ...editor, sessionId: "viewport-1" };
    CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, editor);
    CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, output);
    simulatePointerButton(0, true);
    expect(CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, editor).pressed).toBe(1);
    expect(CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, output).pressed).toBe(1);
    expect(CLICK_NODE.evaluate({}, CLICK_NODE.defaultParams, editor).pressed).toBe(0);
  });
});
