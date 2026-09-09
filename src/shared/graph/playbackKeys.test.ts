import { afterEach, describe, expect, test } from "vitest";
import {
  collectKeyboardBindings,
  getGraphKeyBindings,
  isKeyClaimedByGraph,
  isKeyReservedForPlayback,
  normalizeKeyName,
  setGraphKeyBindings,
  setPlaybackActive,
} from "./playbackKeys";
import { NodeInstance } from "./types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function node(id: string, type: string, params: Record<string, unknown> = {}): NodeInstance {
  return { id, type, params, position: { x: 0, y: 0 } };
}

/** Just the fields the check reads. */
function press(
  key: string,
  code = "",
  modifiers: Partial<Pick<KeyboardEvent, "shiftKey" | "altKey" | "ctrlKey" | "metaKey">> = {},
) {
  return { key, code, ...modifiers };
}

afterEach(() => {
  setPlaybackActive(false);
  setGraphKeyBindings([]);
});

describe("normalizeKeyName", () => {
  test("case and padding do not matter", () => {
    expect(normalizeKeyName("  Z  ")).toBe("z");
    expect(normalizeKeyName("ArrowUp")).toBe("arrowup");
  });

  test("the space bar's two spellings collapse to one", () => {
    // `e.key` is " " and `e.code` is "Space"; authors write either.
    expect(normalizeKeyName(" ")).toBe("space");
    expect(normalizeKeyName("Space")).toBe("space");
  });

  test("nothing is nothing", () => {
    expect(normalizeKeyName(undefined)).toBe("");
    expect(normalizeKeyName(null)).toBe("");
  });
});

describe("collectKeyboardBindings", () => {
  test("gathers the key of every Keyboard node and ignores the rest", () => {
    const keys = collectKeyboardBindings([
      node("a", "io/keyboard", { key: "z" }),
      node("b", "io/keyboard", { key: "Space" }),
      node("c", "object/box", { key: "x" }),
      node("d", "io/gamepad", {}),
    ]);
    expect([...keys].sort()).toEqual(["space", "z"]);
  });

  test("duplicates collapse, and an unset key is skipped", () => {
    const keys = collectKeyboardBindings([
      node("a", "io/keyboard", { key: "d" }),
      node("b", "io/keyboard", { key: "D" }),
      node("c", "io/keyboard", {}),
    ]);
    expect([...keys]).toEqual(["d"]);
  });

  test("an empty or missing graph claims nothing", () => {
    expect(collectKeyboardBindings([]).size).toBe(0);
    expect(collectKeyboardBindings(null).size).toBe(0);
  });
});

describe("Move Input claims its keys too", () => {
  test("a layout's four keys, jump and sprint are all claimed", () => {
    // The regression this pins: the registry knew only about io/keyboard, so
    // the moment Move Input replaced those nodes in every demo the whole
    // mechanism silently stopped working — the scene read ZQSD while the
    // editor still thought nobody was.
    const keys = collectKeyboardBindings([
      node("m", "io/move-input", {
        layout: "zqsd",
        jumpKey: "space",
        sprintKey: "shift",
      }),
    ]);
    expect([...keys].sort()).toEqual(["d", "q", "s", "shift", "space", "z"]);
  });

  test("a combined layout claims the arrows as well", () => {
    const keys = collectKeyboardBindings([
      node("m", "io/move-input", { layout: "zqsd+arrows", jumpKey: "space", sprintKey: "shift" }),
    ]);
    expect(keys.has("arrowup")).toBe(true);
    expect(keys.has("arrowleft")).toBe(true);
    expect(keys.has("z")).toBe(true);
  });

  test("custom keys are claimed, not the layout defaults", () => {
    const keys = collectKeyboardBindings([
      node("m", "io/move-input", {
        layout: "custom",
        forwardKey: "i",
        backKey: "k",
        leftKey: "j",
        rightKey: "l",
        jumpKey: "space",
        sprintKey: "",
      }),
    ]);
    expect([...keys].sort()).toEqual(["i", "j", "k", "l", "space"]);
  });

  test("Keyboard and Move Input nodes in one graph both contribute", () => {
    const keys = collectKeyboardBindings([
      node("k", "io/keyboard", { key: "e" }),
      node("m", "io/move-input", { layout: "wasd", jumpKey: "space", sprintKey: "shift" }),
    ]);
    expect(keys.has("e")).toBe(true);
    expect(keys.has("w")).toBe(true);
  });

  test("a WASD scheme takes S back from the scale gizmo while playing", () => {
    setGraphKeyBindings(
      collectKeyboardBindings([node("m", "io/move-input", { layout: "wasd", jumpKey: "space" })]),
    );
    setPlaybackActive(true);
    expect(isKeyReservedForPlayback(press("s", "KeyS"))).toBe(true);
    // And R, which nothing listens for, still reaches the editor.
    expect(isKeyReservedForPlayback(press("r", "KeyR"))).toBe(false);
  });
});

describe("isKeyReservedForPlayback", () => {
  test("a stopped graph keeps every shortcut, however many keys it listens for", () => {
    // The editor is only ever asked to give up keys while the scene runs.
    setGraphKeyBindings(["z", "s", "space"]);
    setPlaybackActive(false);
    expect(isKeyReservedForPlayback(press("s"))).toBe(false);
  });

  test("while playing, a claimed key belongs to the scene", () => {
    setGraphKeyBindings(["z", "s", "space"]);
    setPlaybackActive(true);
    expect(isKeyReservedForPlayback(press("s"))).toBe(true);
    expect(isKeyReservedForPlayback(press("z"))).toBe(true);
  });

  test("a key nobody listens for stays with the editor even while playing", () => {
    // The rule is narrow on purpose: only the keys the scene actually uses.
    setGraphKeyBindings(["z"]);
    setPlaybackActive(true);
    expect(isKeyReservedForPlayback(press("r"))).toBe(false);
    expect(isKeyReservedForPlayback(press("g"))).toBe(false);
  });

  test("a graph with no Keyboard nodes never takes a key", () => {
    setGraphKeyBindings([]);
    setPlaybackActive(true);
    expect(isKeyReservedForPlayback(press("s"))).toBe(false);
    expect(isKeyReservedForPlayback(press(" ", "Space"))).toBe(false);
  });

  test("the space bar matches whichever way it was written", () => {
    setPlaybackActive(true);

    setGraphKeyBindings(["space"]);
    expect(isKeyReservedForPlayback(press(" ", "Space"))).toBe(true);

    setGraphKeyBindings([" "]);
    expect(isKeyReservedForPlayback(press(" ", "Space"))).toBe(true);
  });

  test("both the letter and the physical position are honoured", () => {
    // On AZERTY these are different letters, so an author who wrote "q" means
    // the letter and one who wrote "keyq" means the key's position.
    setPlaybackActive(true);

    setGraphKeyBindings(["q"]);
    expect(isKeyReservedForPlayback(press("q", "KeyA"))).toBe(true);

    setGraphKeyBindings(["keya"]);
    expect(isKeyReservedForPlayback(press("q", "KeyA"))).toBe(true);
  });

  test("case does not matter on the way in either", () => {
    setPlaybackActive(true);
    setGraphKeyBindings(["Z"]);
    expect(isKeyReservedForPlayback(press("Z", "KeyW"))).toBe(true);
  });

  test("the claimed set is readable, and normalised on the way in", () => {
    setGraphKeyBindings([" ", "  D  ", ""]);
    expect([...getGraphKeyBindings()].sort()).toEqual(["d", "space"]);
  });

  test("claiming is independent of playback state", () => {
    setGraphKeyBindings(["z"]);
    expect(isKeyClaimedByGraph(press("z"))).toBe(true);
    expect(isKeyReservedForPlayback(press("z"))).toBe(false);
  });
});

describe("chords are never reserved", () => {
  test("Shift + a claimed key still reaches the editor", () => {
    // The case that matters: a character jumps on Space, and Shift+Space is
    // Reset Simulations — the one command most wanted while a simulation is
    // running away. Reserving the chord would swallow it.
    setGraphKeyBindings(["space"]);
    setPlaybackActive(true);

    expect(isKeyReservedForPlayback(press(" ", "Space"))).toBe(true);
    expect(isKeyReservedForPlayback(press(" ", "Space", { shiftKey: true }))).toBe(false);
  });

  test("no modifier reserves anything", () => {
    setGraphKeyBindings(["s"]);
    setPlaybackActive(true);

    for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
      expect(isKeyReservedForPlayback(press("s", "KeyS", { [modifier]: true }))).toBe(false);
    }
    // Plain, though, still belongs to the scene.
    expect(isKeyReservedForPlayback(press("s", "KeyS"))).toBe(true);
  });
});

describe("the shipped interactive demos actually claim their keys", () => {
  /**
   * The reported symptom, pinned at the level it was reported: "the shortcuts
   * are active again and I cannot test the demos". A unit test on the registry
   * would not have caught it, because the registry was correct — it was the
   * demos that moved to a node the registry had never heard of.
   */
  const DRIVEABLE = [
    "demo_io_move_input.tsuji",
    "demo_io_action_map.tsuji",
    "demo_physics_character.tsuji",
    "demo_physics_character_rapier.tsuji",
    "demo_physics_vehicle.tsuji",
  ];

  for (const file of DRIVEABLE) {
    test(`${file} claims the keys it is driven with`, () => {
      const text = readFileSync(join(process.cwd(), "public/demos", file), "utf8");
      const project = JSON.parse(text) as { canvases: { nodes: NodeInstance[] }[] };
      const nodes = project.canvases.flatMap((canvas) => canvas.nodes);

      const keys = collectKeyboardBindings(nodes);
      expect(keys.size, `${file} claims no keys, so the editor will eat them`).toBeGreaterThan(0);
    });
  }

  test("a driveable demo takes back the keys that are also editor shortcuts", () => {
    const text = readFileSync(join(process.cwd(), "public/demos", "demo_physics_character_rapier.tsuji"), "utf8");
    const project = JSON.parse(text) as { canvases: { nodes: NodeInstance[] }[] };
    setGraphKeyBindings(collectKeyboardBindings(project.canvases.flatMap((c) => c.nodes)));
    setPlaybackActive(true);

    // S is the scale gizmo, D removes a curve point, Space toggles playback —
    // all three have to belong to the character while it is being driven.
    expect(isKeyReservedForPlayback(press("s", "KeyS"))).toBe(true);
    expect(isKeyReservedForPlayback(press("d", "KeyD"))).toBe(true);
    expect(isKeyReservedForPlayback(press(" ", "Space"))).toBe(true);
  });
});
