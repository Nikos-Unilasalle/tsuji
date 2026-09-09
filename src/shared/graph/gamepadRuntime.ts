/**
 * Gamepad reading, split so the parts worth testing are pure.
 *
 * The browser hands gamepads over by polling, not by events: `getGamepads()`
 * returns a fresh snapshot each call and the objects it returns are not live.
 * That suits the graph exactly — a node evaluates once per frame and asks for
 * the state at that moment — so there is no listener here and nothing to keep
 * in sync, unlike the keyboard's pressed-key set.
 *
 * Everything below `readGamepadSnapshot` takes the raw arrays as arguments
 * rather than reaching for `navigator`, so the deadzone maths — the part that
 * actually decides how a stick feels — can be tested without a browser or a
 * controller plugged in.
 */

/** A gamepad reduced to what a graph cares about. */
export interface GamepadSnapshot {
  connected: boolean;
  id: string;
  /** Raw axes, in the browser's own convention: sticks are −1…1, up is negative. */
  axes: number[];
  /** Button values 0…1 — analogue on triggers, 0 or 1 on everything else. */
  buttons: number[];
}

export const EMPTY_GAMEPAD: GamepadSnapshot = {
  connected: false,
  id: "",
  axes: [],
  buttons: [],
};

/**
 * The W3C "standard gamepad" button order, which every mainstream controller
 * reports through when `mapping === "standard"`.
 */
export const STANDARD_BUTTONS = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  leftBumper: 4,
  rightBumper: 5,
  leftTrigger: 6,
  rightTrigger: 7,
  back: 8,
  start: 9,
  leftStick: 10,
  rightStick: 11,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

export type StandardButton = keyof typeof STANDARD_BUTTONS;

/**
 * A single axis past its deadzone, rescaled so the usable range still spans
 * 0…1.
 *
 * Rescaling is the point. Simply zeroing everything under the threshold leaves
 * a step at the edge of the dead area — the stick does nothing, then jumps
 * straight to 0.15 — which reads as a twitchy control.
 */
export function applyDeadzone(value: number, deadzone: number): number {
  if (!Number.isFinite(value)) return 0;
  const zone = Math.min(0.99, Math.max(0, deadzone));
  const magnitude = Math.abs(value);
  if (magnitude <= zone) return 0;
  const rescaled = (magnitude - zone) / (1 - zone);
  return Math.sign(value) * Math.min(1, rescaled);
}

/**
 * Deadzone applied to a stick as a *circle*, not to each axis on its own.
 *
 * Per-axis deadzones are the classic stick bug: they carve a square hole out
 * of a round stick, so a gentle diagonal push registers on neither axis while
 * the same distance pushed straight up registers fine, and the character
 * refuses to walk diagonally. Taking the magnitude first and rescaling the
 * whole vector keeps the response circular.
 */
export function applyStickDeadzone(x: number, y: number, deadzone: number): { x: number; y: number } {
  const safeX = Number.isFinite(x) ? x : 0;
  const safeY = Number.isFinite(y) ? y : 0;
  const magnitude = Math.hypot(safeX, safeY);
  if (magnitude <= 1e-9) return { x: 0, y: 0 };

  const scaled = applyDeadzone(magnitude, deadzone);
  if (scaled === 0) return { x: 0, y: 0 };

  return { x: (safeX / magnitude) * scaled, y: (safeY / magnitude) * scaled };
}

/** Reads one axis out of a snapshot, or 0 when the pad has no such axis. */
export function axisValue(snapshot: GamepadSnapshot, index: number): number {
  const value = snapshot.axes[index];
  return Number.isFinite(value) ? value : 0;
}

/** Reads one standard button out of a snapshot, or 0 when the pad has no such button. */
export function buttonValue(snapshot: GamepadSnapshot, button: StandardButton): number {
  const value = snapshot.buttons[STANDARD_BUTTONS[button]];
  return Number.isFinite(value) ? value : 0;
}

/** The strongest button currently pressed — a cheap "any input" for menus and attract loops. */
export function maxButton(snapshot: GamepadSnapshot): number {
  let max = 0;
  for (const value of snapshot.buttons) {
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/** Turns a browser Gamepad (or anything shaped like one) into a snapshot. */
export function toSnapshot(pad: unknown): GamepadSnapshot {
  if (!pad || typeof pad !== "object") return EMPTY_GAMEPAD;
  const source = pad as { id?: unknown; axes?: unknown; buttons?: unknown; connected?: unknown };

  const axes = Array.isArray(source.axes) ? source.axes.map((a) => (Number.isFinite(a) ? Number(a) : 0)) : [];

  // Buttons arrive as objects with `value` and `pressed`; a digital button
  // reports value 1, an analogue trigger reports the pull. Reading `value`
  // rather than `pressed` is what keeps triggers analogue.
  const buttons = Array.isArray(source.buttons)
    ? source.buttons.map((button) => {
        if (typeof button === "number") return Number.isFinite(button) ? button : 0;
        const entry = button as { value?: unknown; pressed?: unknown };
        if (typeof entry?.value === "number" && Number.isFinite(entry.value)) return entry.value;
        return entry?.pressed ? 1 : 0;
      })
    : [];

  return {
    connected: source.connected !== false,
    id: typeof source.id === "string" ? source.id : "",
    axes,
    buttons,
  };
}

/**
 * The gamepad at `index`, read fresh from the browser.
 *
 * Absent outside a browser (tests, a headless evaluate), and absent until the
 * user has pressed something: browsers deliberately hide gamepads from a page
 * that has never seen input from them, so a controller that is plugged in but
 * untouched reports as disconnected. That is the API working as intended, not
 * a failure to detect.
 */
export function readGamepadSnapshot(index: number): GamepadSnapshot {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator) : undefined;
  if (!nav || typeof nav.getGamepads !== "function") return EMPTY_GAMEPAD;

  const pads = nav.getGamepads();
  if (!pads) return EMPTY_GAMEPAD;

  const pad = pads[Math.max(0, Math.floor(index))];
  return pad ? toSnapshot(pad) : EMPTY_GAMEPAD;
}

/**
 * Test seam: a snapshot pushed in here is returned by `readGamepadSnapshot`
 * instead of the browser's, so a graph can be driven without a controller.
 */
let simulated: Map<number, GamepadSnapshot> | null = null;

export function simulateGamepad(index: number, snapshot: Partial<GamepadSnapshot> | null): void {
  if (snapshot === null) {
    simulated?.delete(index);
    if (simulated && simulated.size === 0) simulated = null;
    return;
  }
  if (!simulated) simulated = new Map();
  simulated.set(index, { ...EMPTY_GAMEPAD, connected: true, ...snapshot });
}

export function clearSimulatedGamepads(): void {
  simulated = null;
}

/** What the nodes actually call — the simulated pad wins when one is set. */
export function getGamepadSnapshot(index: number): GamepadSnapshot {
  const override = simulated?.get(Math.max(0, Math.floor(index)));
  if (override) return override;
  return readGamepadSnapshot(index);
}
