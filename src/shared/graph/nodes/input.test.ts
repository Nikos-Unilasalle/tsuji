import * as THREE from "three";
import { afterEach, describe, expect, test } from "vitest";
import {
  ACTION_MAP_NODE,
  GAMEPAD_NODE,
  MOVE_INPUT_NODE,
  asMoveLayout,
  combineSources,
  layoutKeys,
  smoothToward,
} from "./input";
import { simulateKeyDown, simulateKeyUp } from "./keyboard";
import { EvalContext } from "../types";
import {
  EMPTY_GAMEPAD,
  STANDARD_BUTTONS,
  applyDeadzone,
  applyStickDeadzone,
  buttonValue,
  clearSimulatedGamepads,
  maxButton,
  simulateGamepad,
  toSnapshot,
} from "../gamepadRuntime";

function makeContext(nodeId: string, time = 0): EvalContext {
  return { nodeId, time, step: Math.floor(time * 60) };
}

afterEach(() => {
  clearSimulatedGamepads();
});

describe("deadzones", () => {
  test("below the threshold is silence, above it is rescaled to reach 1", () => {
    expect(applyDeadzone(0.1, 0.2)).toBe(0);
    expect(applyDeadzone(0.2, 0.2)).toBe(0);
    // Rescaled, not truncated: the usable range still spans the full 0…1.
    expect(applyDeadzone(0.6, 0.2)).toBeCloseTo(0.5, 6);
    expect(applyDeadzone(1, 0.2)).toBeCloseTo(1, 6);
  });

  test("there is no step at the edge of the dead area", () => {
    // Zeroing without rescaling would jump straight from 0 to 0.15 here,
    // which is what makes a stick feel twitchy.
    expect(applyDeadzone(0.1501, 0.15)).toBeLessThan(0.01);
  });

  test("sign is kept and the output never exceeds 1", () => {
    expect(applyDeadzone(-0.6, 0.2)).toBeCloseTo(-0.5, 6);
    expect(applyDeadzone(-5, 0.2)).toBe(-1);
    expect(applyDeadzone(5, 0.2)).toBe(1);
  });

  test("a non-finite axis reads as centred rather than poisoning the maths", () => {
    // A disconnected or malfunctioning pad reporting NaN must not propagate
    // it into a transform — a centred stick is the safe reading.
    expect(applyDeadzone(NaN, 0.1)).toBe(0);
    expect(applyDeadzone(Infinity, 0.1)).toBe(0);
  });

  test("a stick's deadzone is a circle, not a square", () => {
    // The classic bug: per-axis deadzones make a gentle diagonal register on
    // neither axis while the same push straight up works fine, so the
    // character refuses to walk diagonally.
    const deadzone = 0.25;
    const push = 0.22; // under the threshold on each axis alone…
    expect(applyDeadzone(push, deadzone)).toBe(0);

    // …but the diagonal's magnitude (~0.31) is past it, so the stick responds.
    const diagonal = applyStickDeadzone(push, push, deadzone);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeGreaterThan(0);
    expect(diagonal.x).toBeCloseTo(diagonal.y, 10);
  });

  test("the stick keeps its direction while its magnitude is rescaled", () => {
    const before = new THREE.Vector2(0.6, -0.3);
    const after = applyStickDeadzone(before.x, before.y, 0.2);
    const angleBefore = Math.atan2(before.y, before.x);
    const angleAfter = Math.atan2(after.y, after.x);
    expect(angleAfter).toBeCloseTo(angleBefore, 10);
    expect(Math.hypot(after.x, after.y)).toBeLessThan(before.length());
  });

  test("a centred stick is exactly zero, with no divide by its own length", () => {
    const centred = applyStickDeadzone(0, 0, 0.2);
    expect(centred).toEqual({ x: 0, y: 0 });
  });

  test("a fully deflected stick still reaches 1", () => {
    const full = applyStickDeadzone(0, -1, 0.15);
    expect(Math.hypot(full.x, full.y)).toBeCloseTo(1, 6);
  });
});

describe("gamepad snapshots", () => {
  test("buttons are read by value, so triggers stay analogue", () => {
    const snapshot = toSnapshot({
      connected: true,
      id: "pad",
      axes: [0, 0],
      buttons: [{ value: 0.37, pressed: true }, { pressed: true }, { pressed: false }],
    });
    // Reading `pressed` instead would flatten a half-pulled trigger to 1.
    expect(snapshot.buttons[0]).toBeCloseTo(0.37, 6);
    expect(snapshot.buttons[1]).toBe(1);
    expect(snapshot.buttons[2]).toBe(0);
  });

  test("anything not shaped like a gamepad reads as an empty one", () => {
    expect(toSnapshot(null)).toEqual(EMPTY_GAMEPAD);
    expect(toSnapshot(42)).toEqual(EMPTY_GAMEPAD);
    expect(toSnapshot({}).axes).toEqual([]);
  });

  test("missing axes and buttons read as centred and unpressed", () => {
    const snapshot = toSnapshot({ connected: true, axes: [0.5], buttons: [] });
    expect(buttonValue(snapshot, "a")).toBe(0);
    expect(maxButton(snapshot)).toBe(0);
  });

  test("maxButton finds the hardest press for an any-input check", () => {
    const snapshot = toSnapshot({ connected: true, axes: [], buttons: [0, 0.3, 0.9, 0.1] });
    expect(maxButton(snapshot)).toBeCloseTo(0.9, 6);
  });
});

describe("io/gamepad node", () => {
  const params = () => ({ ...GAMEPAD_NODE.defaultParams });

  test("with nothing plugged in, everything reads neutral instead of throwing", () => {
    const out = GAMEPAD_NODE.evaluate({}, params(), makeContext("pad-1")) as {
      connected: number;
      leftStick: THREE.Vector3;
      anyButton: number;
      buttons: number[];
    };
    expect(out.connected).toBe(0);
    expect(out.leftStick.length()).toBe(0);
    expect(out.anyButton).toBe(0);
    expect(out.buttons.length).toBe(Object.keys(STANDARD_BUTTONS).length);
  });

  test("the stick vectors land on the ground plane, up = forward = -Z", () => {
    // Pushing the stick up gives the browser y = -1, which as (x, 0, y) is
    // -Z — forward in a Y-up, -Z-forward world. Getting this sign wrong by
    // hand at every call site is exactly why the node offers the vector.
    simulateGamepad(0, { axes: [0, -1, 0, 0], buttons: [] });
    const out = GAMEPAD_NODE.evaluate({}, params(), makeContext("pad-2")) as {
      leftStick: THREE.Vector3;
      leftY: number;
    };
    expect(out.leftStick.x).toBeCloseTo(0, 6);
    expect(out.leftStick.y).toBe(0);
    expect(out.leftStick.z).toBeCloseTo(-1, 6);
    expect(out.leftY).toBeCloseTo(-1, 6);
  });

  test("both sticks are read independently", () => {
    simulateGamepad(0, { axes: [1, 0, 0, 1], buttons: [] });
    const out = GAMEPAD_NODE.evaluate({}, params(), makeContext("pad-3")) as {
      leftStick: THREE.Vector3;
      rightStick: THREE.Vector3;
    };
    expect(out.leftStick.x).toBeCloseTo(1, 6);
    expect(out.rightStick.z).toBeCloseTo(1, 6);
  });

  test("the d-pad folds into a vector, so it swaps in for a stick", () => {
    const buttons = new Array(16).fill(0);
    buttons[STANDARD_BUTTONS.dpadUp] = 1;
    buttons[STANDARD_BUTTONS.dpadRight] = 1;
    simulateGamepad(0, { axes: [0, 0, 0, 0], buttons });

    const out = GAMEPAD_NODE.evaluate({}, params(), makeContext("pad-4")) as { dpad: THREE.Vector3 };
    expect(out.dpad.x).toBe(1);
    expect(out.dpad.z).toBe(-1);
  });

  test("opposite d-pad directions cancel rather than fighting", () => {
    const buttons = new Array(16).fill(0);
    buttons[STANDARD_BUTTONS.dpadLeft] = 1;
    buttons[STANDARD_BUTTONS.dpadRight] = 1;
    simulateGamepad(0, { axes: [], buttons });

    const out = GAMEPAD_NODE.evaluate({}, params(), makeContext("pad-5")) as { dpad: THREE.Vector3 };
    expect(out.dpad.x).toBe(0);
  });

  test("face buttons and triggers come out separately", () => {
    const buttons = new Array(16).fill(0);
    buttons[STANDARD_BUTTONS.a] = 1;
    buttons[STANDARD_BUTTONS.rightTrigger] = 0.62;
    simulateGamepad(0, { axes: [], buttons });

    const out = GAMEPAD_NODE.evaluate({}, params(), makeContext("pad-6")) as {
      a: number;
      b: number;
      rightTrigger: number;
      anyButton: number;
    };
    expect(out.a).toBe(1);
    expect(out.b).toBe(0);
    expect(out.rightTrigger).toBeGreaterThan(0.5);
    expect(out.anyButton).toBe(1);
  });

  test("the player index picks the pad", () => {
    simulateGamepad(1, { axes: [0.8, 0, 0, 0], buttons: [] });

    const playerOne = GAMEPAD_NODE.evaluate({ index: 0 }, params(), makeContext("pad-7")) as {
      connected: number;
    };
    const playerTwo = GAMEPAD_NODE.evaluate({ index: 1 }, params(), makeContext("pad-7")) as {
      connected: number;
      leftX: number;
    };
    expect(playerOne.connected).toBe(0);
    expect(playerTwo.connected).toBe(1);
    expect(playerTwo.leftX).toBeGreaterThan(0.5);
  });

  test("stick drift under the deadzone is silence", () => {
    simulateGamepad(0, { axes: [0.06, -0.04, 0, 0], buttons: [] });
    const out = GAMEPAD_NODE.evaluate({}, params(), makeContext("pad-8")) as { leftStick: THREE.Vector3 };
    expect(out.leftStick.length()).toBe(0);
  });
});

describe("combineSources", () => {
  test("strongest lets two ways of doing one thing agree", () => {
    // Holding W *and* pushing the stick forward should walk at one speed.
    expect(combineSources([1, 0.8], "strongest")).toBe(1);
    expect(combineSources([0.3, -0.9], "strongest")).toBe(-0.9);
  });

  test("sum and average are there for the cases that really do add up", () => {
    expect(combineSources([0.5, 0.25], "sum")).toBeCloseTo(0.75, 6);
    expect(combineSources([1, 0], "average")).toBeCloseTo(0.5, 6);
  });

  test("nothing wired is nothing, not NaN", () => {
    expect(combineSources([], "strongest")).toBe(0);
    expect(combineSources([], "average")).toBe(0);
    // Non-finite sources are dropped rather than averaged in, so one bad
    // reading cannot take the whole action with it.
    expect(combineSources([NaN, Infinity as number], "average")).toBe(0);
    expect(combineSources([NaN, 0.5], "average")).toBeCloseTo(0.5, 6);
  });
});

describe("smoothToward", () => {
  test("zero smoothing snaps", () => {
    expect(smoothToward(0, 1, 0, 0.016)).toBe(1);
  });

  test("smoothing closes most of the gap over its own time constant", () => {
    const afterOneTau = smoothToward(0, 1, 0.2, 0.2);
    expect(afterOneTau).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  test("it is framerate-independent: two half steps equal one whole step", () => {
    // The bug this pins: a per-frame lerp makes a control sharper on a fast
    // machine than on a slow one, which only shows up on someone else's box.
    const whole = smoothToward(0, 1, 0.3, 0.1);
    const half = smoothToward(smoothToward(0, 1, 0.3, 0.05), 1, 0.3, 0.05);
    expect(half).toBeCloseTo(whole, 10);
  });
});

describe("io/action-map node", () => {
  const params = (overrides: Record<string, unknown> = {}) => ({
    ...ACTION_MAP_NODE.defaultParams,
    ...overrides,
  });

  test("positive minus negative makes an axis out of two digital keys", () => {
    // D and A, or the two halves of any axis: the case an "add up the inputs"
    // node cannot express.
    const forward = ACTION_MAP_NODE.evaluate({ pos0: 1, neg0: 0 }, params(), makeContext("act-1")) as {
      value: number;
    };
    const back = ACTION_MAP_NODE.evaluate({ pos0: 0, neg0: 1 }, params(), makeContext("act-2")) as {
      value: number;
    };
    const both = ACTION_MAP_NODE.evaluate({ pos0: 1, neg0: 1 }, params(), makeContext("act-3")) as {
      value: number;
    };
    expect(forward.value).toBe(1);
    expect(back.value).toBe(-1);
    expect(both.value).toBe(0);
  });

  test("several sources for one action do not stack up", () => {
    const out = ACTION_MAP_NODE.evaluate(
      { pos0: 1, pos1: 0.9, pos2: 0.4 },
      params(),
      makeContext("act-4"),
    ) as { value: number };
    expect(out.value).toBe(1);
  });

  test("sum mode is available when the sources really should add", () => {
    const out = ACTION_MAP_NODE.evaluate(
      { pos0: 0.5, pos1: 0.25 },
      params({ mode: "sum" }),
      makeContext("act-5"),
    ) as { value: number };
    expect(out.value).toBeCloseTo(0.75, 6);
  });

  test("scale, invert and clamp apply in that order", () => {
    const scaled = ACTION_MAP_NODE.evaluate(
      { pos0: 0.5 },
      params({ scale: 4, clamp: false }),
      makeContext("act-6"),
    ) as { value: number };
    expect(scaled.value).toBeCloseTo(2, 6);

    const clamped = ACTION_MAP_NODE.evaluate(
      { pos0: 0.5 },
      params({ scale: 4, clamp: true }),
      makeContext("act-7"),
    ) as { value: number };
    expect(clamped.value).toBe(1);

    const inverted = ACTION_MAP_NODE.evaluate(
      { pos0: 1 },
      params({ invert: true }),
      makeContext("act-8"),
    ) as { value: number };
    expect(inverted.value).toBe(-1);
  });

  test("active, pressed and released describe one edge each", () => {
    const id = "act-edges";
    const idle = ACTION_MAP_NODE.evaluate({ pos0: 0 }, params(), makeContext(id, 0)) as {
      active: number;
      pressed: number;
    };
    expect(idle.active).toBe(0);
    expect(idle.pressed).toBe(0);

    const down = ACTION_MAP_NODE.evaluate({ pos0: 1 }, params(), makeContext(id, 0.1)) as {
      active: number;
      pressed: number;
      released: number;
    };
    expect(down.active).toBe(1);
    expect(down.pressed).toBe(1);
    expect(down.released).toBe(0);

    const held = ACTION_MAP_NODE.evaluate({ pos0: 1 }, params(), makeContext(id, 0.2)) as {
      pressed: number;
    };
    // Pressed is an edge, not a state.
    expect(held.pressed).toBe(0);

    const up = ACTION_MAP_NODE.evaluate({ pos0: 0 }, params(), makeContext(id, 0.3)) as {
      active: number;
      released: number;
    };
    expect(up.active).toBe(0);
    expect(up.released).toBe(1);
  });

  test("smoothing ramps the value instead of snapping it", () => {
    const id = "act-smooth";
    ACTION_MAP_NODE.evaluate({ pos0: 0 }, params({ smoothing: 0.25 }), makeContext(id, 0));
    const mid = ACTION_MAP_NODE.evaluate(
      { pos0: 1 },
      params({ smoothing: 0.25 }),
      makeContext(id, 0.05),
    ) as { value: number };

    expect(mid.value).toBeGreaterThan(0);
    expect(mid.value).toBeLessThan(1);
  });

  test("the deadzone applies to the combined axis, not to each source", () => {
    const out = ACTION_MAP_NODE.evaluate(
      { pos0: 0.1 },
      params({ deadzone: 0.2 }),
      makeContext("act-9"),
    ) as { value: number };
    expect(out.value).toBe(0);
  });

  test("the threshold decides Active, so an analogue stick can trigger a discrete event", () => {
    const soft = ACTION_MAP_NODE.evaluate(
      { pos0: 0.3 },
      params({ threshold: 0.5 }),
      makeContext("act-10"),
    ) as { active: number };
    const firm = ACTION_MAP_NODE.evaluate(
      { pos0: 0.8 },
      params({ threshold: 0.5 }),
      makeContext("act-11"),
    ) as { active: number };
    expect(soft.active).toBe(0);
    expect(firm.active).toBe(1);
  });

  test("its sockets grow as they are wired, one free slot always left", () => {
    const connections = [
      { id: "c1", fromNode: "k", fromSocket: "isDown", toNode: "a", toSocket: "pos0" },
      { id: "c2", fromNode: "g", fromSocket: "leftX", toNode: "a", toSocket: "pos1" },
      { id: "c3", fromNode: "k2", fromSocket: "isDown", toNode: "a", toSocket: "neg0" },
    ];
    const sockets = ACTION_MAP_NODE.dynamicInputs!(connections as any);
    const ids = sockets.map((s) => s.id);
    expect(ids).toContain("pos2");
    expect(ids).toContain("neg1");
    expect(ids).not.toContain("pos4");
  });

  test("nothing wired is a resting action, not a NaN", () => {
    const out = ACTION_MAP_NODE.evaluate({}, params(), makeContext("act-12")) as {
      value: number;
      active: number;
    };
    expect(out.value).toBe(0);
    expect(out.active).toBe(0);
  });
});

describe("io/move-input", () => {
  const params = (overrides: Record<string, unknown> = {}) => ({
    ...MOVE_INPUT_NODE.defaultParams,
    ...overrides,
  });

  afterEach(() => {
    for (const key of ["z", "q", "s", "d", "w", "a", "arrowup", "arrowleft", " ", "space", "shift"]) {
      simulateKeyUp(key);
    }
  });

  test("a layout names its four keys, and the combined ones add the arrows", () => {
    expect(layoutKeys("zqsd")).toEqual({ forward: ["z"], back: ["s"], left: ["q"], right: ["d"] });
    expect(layoutKeys("wasd").forward).toEqual(["w"]);
    expect(layoutKeys("zqsd+arrows").forward).toEqual(["z", "arrowup"]);
    expect(layoutKeys("arrows").left).toEqual(["arrowleft"]);
  });

  test("custom takes the four keys given to it", () => {
    expect(layoutKeys("custom", ["i", "k", "j", "l"]).right).toEqual(["l"]);
  });

  test("an unknown layout falls back rather than producing nothing", () => {
    expect(asMoveLayout("dvorak")).toBe("zqsd");
    expect(asMoveLayout(undefined)).toBe("zqsd");
  });

  test("forward is -Z, so it drops into a controller without a sign fix", () => {
    simulateKeyDown("z");
    const out = MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0 }), makeContext("m1", 0)) as {
      move: THREE.Vector3;
      z: number;
    };
    expect(out.move.z).toBeCloseTo(-1, 6);
    expect(out.move.x).toBe(0);
    expect(out.move.y).toBe(0);
  });

  test("the four directions each move the right way", () => {
    const read = (key: string, id: string) => {
      simulateKeyDown(key);
      const out = MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0 }), makeContext(id, 0)) as {
        move: THREE.Vector3;
      };
      simulateKeyUp(key);
      return out.move;
    };

    expect(read("s", "m2a").z).toBeCloseTo(1, 6);
    expect(read("d", "m2b").x).toBeCloseTo(1, 6);
    expect(read("q", "m2c").x).toBeCloseTo(-1, 6);
  });

  test("a keyboard diagonal is not faster than a straight line", () => {
    simulateKeyDown("z");
    simulateKeyDown("d");
    const out = MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0 }), makeContext("m3", 0)) as {
      magnitude: number;
    };
    expect(out.magnitude).toBeCloseTo(1, 5);
  });

  test("opposite keys cancel", () => {
    simulateKeyDown("z");
    simulateKeyDown("s");
    const out = MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0 }), makeContext("m4", 0)) as {
      magnitude: number;
    };
    expect(out.magnitude).toBe(0);
  });

  test("the arrow keys work too on a combined layout", () => {
    simulateKeyDown("arrowup");
    const out = MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0 }), makeContext("m5", 0)) as {
      move: THREE.Vector3;
    };
    expect(out.move.z).toBeCloseTo(-1, 6);
  });

  test("a gamepad stick feeds the same vector, and the harder push wins", () => {
    // Holding a key *and* pushing the stick must walk at one speed, not two.
    simulateGamepad(0, { axes: [0, -1, 0, 0], buttons: [] });
    simulateKeyDown("z");

    const out = MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0 }), makeContext("m6", 0)) as {
      magnitude: number;
      move: THREE.Vector3;
    };
    expect(out.move.z).toBeCloseTo(-1, 6);
    expect(out.magnitude).toBeCloseTo(1, 5);
  });

  test("a half-pushed stick stays half", () => {
    simulateGamepad(0, { axes: [0, -0.5, 0, 0], buttons: [] });
    const out = MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0, deadzone: 0 }), makeContext("m7", 0)) as {
      magnitude: number;
    };
    expect(out.magnitude).toBeGreaterThan(0.3);
    expect(out.magnitude).toBeLessThan(0.7);
  });

  test("the gamepad can be switched off", () => {
    simulateGamepad(0, { axes: [1, 0, 0, 0], buttons: [] });
    const out = MOVE_INPUT_NODE.evaluate(
      {},
      params({ smoothing: 0, useGamepad: false }),
      makeContext("m8", 0),
    ) as { magnitude: number };
    expect(out.magnitude).toBe(0);
  });

  test("jump reports both the hold and the press", () => {
    const id = "m9";
    simulateKeyDown("space");

    const first = MOVE_INPUT_NODE.evaluate({}, params(), makeContext(id, 0)) as {
      jump: number;
      jumpPressed: number;
    };
    const held = MOVE_INPUT_NODE.evaluate({}, params(), makeContext(id, 0.1)) as {
      jump: number;
      jumpPressed: number;
    };

    expect(first.jump).toBe(1);
    expect(first.jumpPressed).toBe(1);
    // Pressed is an edge, not a state.
    expect(held.jump).toBe(1);
    expect(held.jumpPressed).toBe(0);

    simulateKeyUp("space");
  });

  test("Enabled off silences everything, so a menu can take the keyboard back", () => {
    simulateKeyDown("z");
    const out = MOVE_INPUT_NODE.evaluate(
      { enabled: 0 },
      params({ smoothing: 0 }),
      makeContext("m10", 0),
    ) as { magnitude: number; jump: number };
    expect(out.magnitude).toBe(0);
    expect(out.jump).toBe(0);
  });

  test("the speed multiplier scales the vector without changing its direction", () => {
    simulateKeyDown("d");
    const out = MOVE_INPUT_NODE.evaluate(
      { speed: 4 },
      params({ smoothing: 0 }),
      makeContext("m11", 0),
    ) as { move: THREE.Vector3; magnitude: number };
    expect(out.move.x).toBeCloseTo(4, 5);
    expect(out.magnitude).toBeCloseTo(4, 5);
  });

  test("smoothing ramps instead of snapping, and is framerate independent", () => {
    const id = "m12";
    MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0.25 }), makeContext(id, 0));
    simulateKeyDown("d");
    const mid = MOVE_INPUT_NODE.evaluate({}, params({ smoothing: 0.25 }), makeContext(id, 0.05)) as {
      x: number;
    };
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(1);
  });

  test("nothing pressed is a resting vector, not a NaN", () => {
    const out = MOVE_INPUT_NODE.evaluate({}, params(), makeContext("m13", 0)) as {
      move: THREE.Vector3;
      magnitude: number;
    };
    expect(out.move.toArray()).toEqual([0, 0, 0]);
    expect(out.magnitude).toBe(0);
  });
});
