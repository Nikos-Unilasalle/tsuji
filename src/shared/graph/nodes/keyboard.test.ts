import { describe, expect, it } from "vitest";
import { EvalContext } from "../types";
import { KEYBOARD_NODE, simulateKeyDown, simulateKeyUp } from "./keyboard";

const CTX: EvalContext = { time: 0, step: 0, nodeId: "key-1" };

describe("KEYBOARD_NODE", () => {
  it("detects key isDown and rising edge pressed", () => {
    // Initial state (key not pressed)
    let res = KEYBOARD_NODE.evaluate({ key: "a" }, {}, CTX);
    expect(res.isDown).toBe(0);
    expect(res.pressed).toBe(0);

    // Simulate pressing key "a"
    simulateKeyDown("a");

    // First frame of press: isDown = 1, pressed = 1
    res = KEYBOARD_NODE.evaluate({ key: "a" }, {}, CTX);
    expect(res.isDown).toBe(1);
    expect(res.pressed).toBe(1);

    // Second frame (held down): isDown = 1, pressed = 0
    res = KEYBOARD_NODE.evaluate({ key: "a" }, {}, CTX);
    expect(res.isDown).toBe(1);
    expect(res.pressed).toBe(0);

    // Key released: isDown = 0, pressed = 0
    simulateKeyUp("a");
    res = KEYBOARD_NODE.evaluate({ key: "a" }, {}, CTX);
    expect(res.isDown).toBe(0);
    expect(res.pressed).toBe(0);
  });

  it("handles space bar and case insensitivity", () => {
    simulateKeyDown("space");
    const res = KEYBOARD_NODE.evaluate({ key: "Space" }, {}, CTX);
    expect(res.isDown).toBe(1);
    simulateKeyUp("space");
  });

  it("every viewport sees the key press once", () => {
    const editor: EvalContext = { ...CTX, nodeId: "key-views", sessionId: "viewport-0" };
    const output: EvalContext = { ...editor, sessionId: "viewport-1" };
    KEYBOARD_NODE.evaluate({ key: "q" }, {}, editor);
    KEYBOARD_NODE.evaluate({ key: "q" }, {}, output);
    simulateKeyDown("q");
    expect(KEYBOARD_NODE.evaluate({ key: "q" }, {}, editor).pressed).toBe(1);
    expect(KEYBOARD_NODE.evaluate({ key: "q" }, {}, output).pressed).toBe(1);
    simulateKeyUp("q");
  });
});
