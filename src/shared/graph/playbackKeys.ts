import { NodeInstance } from "./types";

/**
 * Which keys the running graph has claimed, so playback can take them back
 * from the editor's shortcuts.
 *
 * The collision is unavoidable and gets worse the more the engine can do: a
 * character walks on ZQSD, and in this editor S is the scale gizmo, Z is the
 * front view, D removes a curve point and Space toggles playback. Pressing S
 * to walk backwards would put the gizmo into scale mode behind the scene the
 * author is trying to drive.
 *
 * The rule is narrow on purpose — a shortcut is suppressed only when **all**
 * of these hold:
 *
 * - playback is running, and
 * - a Keyboard node in the current graph is actually listening for that key.
 *
 * So a graph with no Keyboard nodes keeps every shortcut while playing, and a
 * stopped graph keeps every shortcut regardless of what it listens for. The
 * editor only ever loses the keys the scene is genuinely using, and only while
 * the scene is running.
 */

/** The node type that claims keys. */
const KEYBOARD_NODE_TYPE = "io/keyboard";

let claimedKeys: ReadonlySet<string> = new Set();
let playbackActive = false;

/**
 * Normalises a key name the way the Keyboard node stores it — see
 * `isKeyPressed` in nodes/keyboard.ts, which lowercases both `e.key` and
 * `e.code` into one set.
 */
export function normalizeKeyName(name: unknown): string {
  const raw = String(name ?? "").toLowerCase();
  // The one name with two spellings: `e.key` is " " while `e.code` is "space",
  // and authors write either. Tested before trimming, or the space bar trims
  // away to nothing and never matches.
  if (raw === " ") return "space";
  return raw.trim();
}

/** Every key the graph's Keyboard nodes are listening for. */
export function collectKeyboardBindings(nodes: readonly NodeInstance[] | undefined | null): Set<string> {
  const keys = new Set<string>();
  if (!nodes) return keys;

  for (const node of nodes) {
    if (node.type !== KEYBOARD_NODE_TYPE) continue;
    const key = normalizeKeyName(node.params?.key);
    if (key) keys.add(key);
  }
  return keys;
}

export function setGraphKeyBindings(keys: Iterable<string>): void {
  const normalized = new Set<string>();
  for (const key of keys) {
    const name = normalizeKeyName(key);
    if (name) normalized.add(name);
  }
  claimedKeys = normalized;
}

export function getGraphKeyBindings(): ReadonlySet<string> {
  return claimedKeys;
}

export function setPlaybackActive(active: boolean): void {
  playbackActive = active;
}

export function isPlaybackActive(): boolean {
  return playbackActive;
}

/**
 * True when this event's key is one the graph listens for.
 *
 * Both `key` and `code` are tested because the Keyboard node accepts either
 * spelling: "a" and "keya" both name the same physical key, and on an AZERTY
 * layout they are not the same letter — an author who wrote "q" means the
 * letter, one who wrote "keyq" means the position.
 */
export function isKeyClaimedByGraph(event: Pick<KeyboardEvent, "key" | "code">): boolean {
  if (claimedKeys.size === 0) return false;

  const key = normalizeKeyName(event.key);
  const code = normalizeKeyName(event.code);
  return claimedKeys.has(key) || claimedKeys.has(code);
}

/**
 * The single check every editor shortcut makes before acting: is the scene
 * currently using this key?
 */
export function isKeyReservedForPlayback(event: Pick<KeyboardEvent, "key" | "code">): boolean {
  return playbackActive && isKeyClaimedByGraph(event);
}
