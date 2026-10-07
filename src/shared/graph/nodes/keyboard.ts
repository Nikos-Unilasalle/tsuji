import { fromBoolean } from "../sockets";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { perSession, sessionKey } from "../sessionState";

// Global set tracking currently pressed keys
const pressedKeys = new Set<string>();
/** Per render loop, so each viewport sees every key press once — see sessionState.ts. */
const prevKeyStateCache = createNodeCache<Map<string, boolean>>();

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      // Ignore key events when user is typing in text fields
      return;
    }
    const key = e.key ? e.key.toLowerCase() : "";
    const code = e.code ? e.code.toLowerCase() : "";
    if (key) pressedKeys.add(key);
    if (code) pressedKeys.add(code);
  });

  window.addEventListener("keyup", (e) => {
    const key = e.key ? e.key.toLowerCase() : "";
    const code = e.code ? e.code.toLowerCase() : "";
    if (key) pressedKeys.delete(key);
    if (code) pressedKeys.delete(code);
  });

  window.addEventListener("blur", () => {
    pressedKeys.clear();
  });
}

/** Helper to check if a target key string is currently pressed */
export function isKeyPressed(targetKey: string): boolean {
  if (!targetKey) return false;
  const target = targetKey.trim().toLowerCase();
  if (target === "space" || target === " ") {
    return pressedKeys.has(" ") || pressedKeys.has("space");
  }
  return pressedKeys.has(target);
}

/** For testing purposes to simulate key events programmatically */
export function simulateKeyDown(keyName: string) {
  const k = keyName.toLowerCase();
  pressedKeys.add(k);
}

export function simulateKeyUp(keyName: string) {
  const k = keyName.toLowerCase();
  pressedKeys.delete(k);
}

/**
 * Keyboard Input node — detects keyboard presses for interactive animations.
 * Outputs `isDown` (1 while key is held down) and `pressed` (1 on initial press frame).
 */
export const KEYBOARD_NODE: NodeDefinition = {
  type: "io/keyboard",
  label: "Keyboard",
  category: "io",
  inputs: [{ id: "key", label: "Key", type: "text" }],
  outputs: [
    { id: "isDown", label: "Is Down", type: "value" },
    { id: "pressed", label: "Pressed", type: "value" },
  ],
  defaultParams: { key: "a" },
  paramFields: [
    { id: "key", label: "Key (e.g. a, Space, Enter, ArrowUp)", kind: "text" },
  ],
  evaluate: (inputs, params, ctx) => {
    const keyInput = inputs.key !== undefined ? String(inputs.key) : String(params.key ?? "a");
    const isDown = isKeyPressed(keyInput);

    let sessions = prevKeyStateCache.get(ctx.nodeId);
    if (!sessions) prevKeyStateCache.set(ctx.nodeId, (sessions = new Map()));
    const key = sessionKey(ctx);
    const prev = sessions.get(key) ?? false;
    perSession(sessions, key, () => isDown);
    sessions.set(key, isDown);

    const pressed = isDown && !prev;

    return {
      isDown: fromBoolean(isDown),
      pressed: fromBoolean(pressed),
    };
  },
};
